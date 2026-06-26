---
title: "Direct-to-S3 uploads with presigned POST URLs"
description: "Big files shouldn't stream through your API. Handing the browser a presigned URL and registering the file after."
date: "2026-01-27"
updated: "2026-01-27"
kind: "deepdive"
category: "Backend"
tags: ["s3", "aws", "uploads", "nestjs"]
month: "2026-01"
repo: "backend"
author: "Sachal Chandio"
---

The memory graph on our staging box had a sawtooth shape to it, and every tooth lined up with someone uploading an inventory sheet. A rep would drop a 40MB CSV of SIM batches into the task attachment field, and that whole file would ride through the NestJS process — into a Multer buffer, held in RAM, then pushed up to S3 with the AWS SDK. Two or three reps doing that at once and the Node heap would balloon, the event loop would get sticky, and unrelated GraphQL requests would start timing out. The file never needed to touch our server at all. It was just passing through because that's how I wired it the first time.

So I moved the bytes off the critical path. The browser uploads straight to S3, the API never sees the file, and we only record a row once S3 tells us the object landed.

## Why presigned POST and not PUT

S3 gives you two ways to hand a client temporary upload rights. A presigned **PUT** URL is one signed URL — the client `PUT`s the raw body to it, done. A presigned **POST** is a URL plus a set of form fields that encode a policy: allowed key, content-type, a size range, an expiry. The client builds a `multipart/form-data` request from those fields.

PUT is simpler to generate. POST is what I wanted, because the policy is the whole point. I needed to constrain what an authenticated-but-not-trusted browser could push:

- the exact object key (so a rep can't overwrite someone else's file by guessing a key),
- a content-length range (reject the 2GB "oops" before a byte is transferred),
- the content-type.

With PUT you can sign some of that, but the size limit in particular is clean with POST — `content-length-range` is a first-class policy condition, and S3 enforces it server-side. You don't get to lie about your file size and slip it past.

## The GraphQL query that mints the URL

We're GraphQL end to end, so this is a query, not a REST endpoint. The client asks for an upload URL, gets back the destination and the fields, and uses them directly against the S3 bucket URL. Nothing about the file body goes through us.

```ts
@ObjectType()
class PresignedUpload {
  @Field() url: string;          // the S3 bucket endpoint to POST to
  @Field(() => GraphQLJSON) fields: Record<string, string>;
  @Field() key: string;          // the object key we reserved
  @Field() expiresAt: string;
}

@Resolver()
export class UploadResolver {
  constructor(private readonly uploads: UploadService) {}

  @Query(() => PresignedUpload)
  @UseGuards(GqlAuthGuard)
  async getUploadUrl(
    @Args('filename') filename: string,
    @Args('contentType') contentType: string,
    @Args('size', { type: () => Int }) size: number,
    @CurrentUser() user: AuthUser,
  ): Promise<PresignedUpload> {
    return this.uploads.createPresignedPost({ filename, contentType, size, user });
  }
}
```

I pass `size` up front on purpose. The client knows the file size before it uploads — `File.size` is right there — so I let it tell me, and I bake a tight range into the policy around that number. If the actual upload doesn't match, S3 rejects it. A client lying about the size only hurts itself.

The service is where the real decisions live:

```ts
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const ALLOWED = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

async createPresignedPost({ filename, contentType, size, user }: Args) {
  if (!ALLOWED.has(contentType)) {
    throw new BadRequestException(`content-type ${contentType} not allowed`);
  }
  if (size <= 0 || size > 50 * 1024 * 1024) {
    throw new BadRequestException('file exceeds 50MB limit');
  }

  // Never trust the client's filename for the key. Slugify, prefix, randomize.
  const safeName = slugify(filename, { lower: true, strict: true });
  const key = `uploads/${user.orgId}/${randomUUID()}-${safeName}`;

  const { url, fields } = await createPresignedPost(this.s3, {
    Bucket: this.bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, size + 1024], // small slack for multipart overhead
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: 300, // seconds
  });

  // Stash a pending record so we can reconcile later.
  await this.pending.save({
    key, contentType, size,
    ownerId: user.id, orgId: user.orgId,
    status: 'PENDING', createdAt: new Date(),
  });

  return { url, fields, key, expiresAt: addSeconds(new Date(), 300).toISOString() };
}
```

The browser side is almost boring, which is the point — append the returned `fields` to a `FormData`, append the file **last** (S3 ignores anything in the form after the `file` field), and POST:

```ts
const form = new FormData();
Object.entries(fields).forEach(([k, v]) => form.append(k, v));
form.append('file', file); // must be the final field
const res = await fetch(url, { method: 'POST', body: form });
// 204 No Content means S3 accepted it
```

A `204` and we're done on the wire. No bytes through Node, no Multer, no buffer sitting in the heap.

## Registering the file after S3 confirms it

Here's the part people skip, and it's the part that matters. The upload succeeding in the browser does not mean the file is registered in your system. You have a `PENDING` row and an object in a bucket, and nothing connecting them to a task yet. The client has to come back and tell you it finished:

```ts
@Mutation(() => Attachment)
@UseGuards(GqlAuthGuard)
async confirmUpload(
  @Args('key') key: string,
  @Args('taskId', { type: () => Int }) taskId: number,
  @CurrentUser() user: AuthUser,
) {
  const pending = await this.pending.findOneByOrFail({ key, ownerId: user.id });

  // Trust S3, not the client. HeadObject proves the bytes are really there.
  const head = await this.s3.send(
    new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
  );

  if (head.ContentLength !== pending.size) {
    throw new BadRequestException('uploaded size does not match reservation');
  }

  const attachment = await this.attachments.save({
    taskId, key,
    contentType: head.ContentType,
    size: head.ContentLength,
    uploadedBy: user.id,
  });

  pending.status = 'CONFIRMED';
  await this.pending.save(pending);
  return attachment;
}
```

`HeadObjectCommand` is the load-bearing call. It's one cheap metadata request — no body transfer — and it's the difference between "the client claims it uploaded" and "S3 confirms the object exists with this size and content-type." I check the size against what we reserved. If they don't match, something is off and I don't create the attachment.

## The sharp edges

**Content-Type has to match exactly, byte for byte.** My first version signed `Content-Type: text/csv` in the policy but the browser sent `text/csv;charset=utf-8` for some files, and S3 returned a `403` with a `SignatureDoesNotMatch`-flavored XML body that told me almost nothing useful. The fix: the content-type the client puts in the form **must** equal the one in the signed policy condition exactly. I now send the same `contentType` string the client gave me on `getUploadUrl` back into the form, and I validate it against my allowlist up front rather than trying to normalize it later.

**The size range bit me on overhead.** I first set `content-length-range` to `[size, size]` — exact match. Multipart form encoding adds a few hundred bytes of boundaries and headers, and... no, actually S3's range applies to the file content, not the form envelope, so that wasn't it — what bit me was a client that recompressed an image before upload and changed its size. Lesson: don't pin the range to the byte. I give it a small band and let `HeadObject` be the real check afterward.

**Orphaned objects from abandoned uploads.** A rep uploads to S3, gets a `204`, then closes the tab before `confirmUpload` fires. Now there's a real object in the bucket and a `PENDING` row that never advances. I run a nightly Bull job that sweeps `pending` rows older than an hour: for each, `HeadObject` the key — if the object exists but was never confirmed, `DeleteObject` it and mark the row `ABANDONED`; if the object doesn't exist (upload never completed), just mark the row and move on. Belt and suspenders, I also set an S3 lifecycle rule to expire anything under `uploads/` with no tag after a day, so even if my job breaks, the bucket doesn't grow forever.

```ts
@Process('reconcile-uploads')
async reconcile() {
  const stale = await this.pending.find({
    where: { status: 'PENDING', createdAt: LessThan(subHours(new Date(), 1)) },
  });
  for (const row of stale) {
    const exists = await this.objectExists(row.key);
    if (exists) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: row.key }));
    row.status = 'ABANDONED';
    await this.pending.save(row);
  }
}
```

**CORS, of course.** The bucket needs a CORS policy that allows `POST` from the app origin and exposes nothing it doesn't need to. Forget that and the browser blocks the request before S3 ever sees it, and the network tab shows you a CORS error that has nothing to do with your signing logic. I lost twenty minutes to that the first time.

## What I'd do differently

The confirm round-trip is the weak link. A client can always crash between the S3 `204` and calling `confirmUpload`, and then I'm relying on the reconcile job to clean up — which works, but it means there's a window where a successfully uploaded file isn't attached to anything. The cleaner design is **S3 event notifications**: have S3 fire an event on `s3:ObjectCreated:Post` to an SQS queue, drain that queue with a worker, and register the attachment server-side from the event instead of trusting the browser to come back. The key already encodes the org and a UUID, so the worker has everything it needs to look up the pending row. I didn't build it that way first because the confirm mutation was thirty minutes of work and the event pipeline was an afternoon plus IAM. The mutation shipped, it's fine, and the reconcile job covers the gap. But if you're starting fresh and you care about never dropping a file, sign the upload on the way out and register it from the S3 event on the way in — don't make the browser the source of truth for what made it to the bucket.
