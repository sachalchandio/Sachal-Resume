---
title: "Inventory categories you can define yourself"
description: "Hardcoded categories never match how a team really organizes stock. Making them data, end to end."
date: "2025-08-19"
updated: "2025-08-19"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "nestjs", "dynamic"]
month: "2025-08"
repo: "frontend"
author: "Sachal Chandio"
---

The inventory module shipped with a TypeScript enum that had twenty-four values in it. `LAPTOP`, `DESKTOP`, `MONITOR`, `KEYBOARD`, all the way down to `OTHER`. It looked thorough on the day I wrote it. Then the ops lead asked me to add a category for SIM kits, and the only honest answer was: I'll add it in the next deploy.

That is a bad answer. The team organizes stock the way the warehouse actually looks, not the way I imagined it from a desk. SIM kits, branded merch, demo handsets that never sell — none of those were in my enum, and every one of them was a real bin on a real shelf. So they started filing everything under `OTHER`, which is how you end up with forty percent of your inventory in a bucket called "we didn't have a name for this."

The fix is obvious in hindsight. Categories are data. Let the people who run the warehouse define them. The work was making that true on both sides of the wire without breaking the dozens of items already pointing at enum values.

## The thing I was replacing

Here's what the old category looked like. A GraphQL-registered enum, baked into the schema:

```ts
export enum InventoryCategory {
  LAPTOP = 'LAPTOP',
  DESKTOP = 'DESKTOP',
  MONITOR = 'MONITOR',
  // ...twenty more
  OTHER = 'OTHER',
}

registerEnumType(InventoryCategory, {
  name: 'InventoryCategory',
  description: 'The category of inventory items',
});
```

The inventory item stored the category as a column with that enum type. Adding a value meant editing this file, regenerating the GraphQL schema, running an `ALTER TABLE ... MODIFY COLUMN` to widen the MySQL enum, and shipping. Four steps and a deploy to add one word.

What I wanted instead was a table. A category gets an id, a name, a human label, an optional icon, a description, and an `isActive` flag so nothing ever gets hard-deleted out from under existing items. The inventory item points at it with a foreign key.

```ts
@ObjectType()
@Entity('inventory_categories')
export class InventoryCategory extends BaseEntity {
  @Column({ length: 100, nullable: false, unique: true })
  name: string;          // machine name, e.g. SIM_KIT

  @Column({ length: 100, nullable: false })
  label: string;         // what humans read, e.g. "SIM Kits"

  @Column({ length: 50, nullable: true })
  icon?: string;         // a Material icon id

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  @Column({ type: 'int', default: 0, nullable: false })
  itemCount: number;

  @OneToMany(() => Inventory, (inventory) => inventory.category)
  inventories: Inventory[];
}
```

The `name` is unique and uppercased — it's the stable identifier that survives a rename. The `label` is what the UI shows and can be edited freely. That split mattered later, when someone wanted to rename "SIM Kits" to "Activation Kits" without invalidating any references.

On the inventory side, the enum column became a relation. The detail that earns its keep is `onDelete: 'RESTRICT'`:

```ts
@ManyToOne(() => InventoryCategory, (category) => category.inventories, {
  eager: true,
  onDelete: 'RESTRICT',
})
@JoinColumn({ name: 'categoryId', foreignKeyConstraintName: 'FK_inventory_categoryId' })
category: InventoryCategory;
```

You cannot delete a category that still has items. The database refuses it, not just the service layer. I wanted the constraint to live where it can't be bypassed by a stray script.

## Delete is a lie; deactivate is the truth

The first real decision was what "delete a category" means. My naive version had a single `DELETE` mutation. Then I thought about what happens when someone deletes "Laptops" while there are sixty laptops pointing at it. You either orphan the items or cascade the delete and lose them. Both are wrong.

So delete became three operations with different blast radii. Soft delete flips `isActive` to false — the category disappears from the pickers but every existing item keeps its link. Reactivate flips it back. And a hard delete exists, but it checks first and throws if anything is still attached:

```ts
async deleteCategory(id: string): Promise<boolean> {
  const category = await this.categoryRepository.findOne({
    where: { id },
    relations: ['inventories'],
  });
  if (!category) {
    throw new NotFoundException(`Category with ID "${id}" not found`);
  }
  if (category.inventories && category.inventories.length > 0) {
    throw new ConflictException(
      `Cannot delete category "${category.name}" as it has ` +
      `${category.inventories.length} associated items`,
    );
  }
  await this.categoryRepository.remove(category);
  return true;
}
```

Hard delete is gated to ADMIN only in the resolver. Soft delete and reactivate go to ADMIN, MANAGER, IT_ADMIN, and HR. The mismatch is deliberate — most people should be able to retire a category, almost nobody should be able to erase one.

## The API the cards actually needed

A category list isn't interesting on its own. The inventory dashboard renders each category as a card with a count, and clicking it expands the items underneath with their available-versus-assigned split. If I returned bare categories, the frontend would have to fan out one query per card to fetch items and another to count units. That's an N+1 waiting to happen on a page that loads on every visit.

So `getAllCategories` and `getActiveCategories` batch the whole thing. One query pulls every inventory row for the requested category ids, with unit counts computed in the same statement via `loadRelationCountAndMap`, then I bucket the results into a map keyed by category:

```ts
private async loadInventoriesByCategoryIds(
  categoryIds: string[],
): Promise<Map<string, Inventory[]>> {
  if (!categoryIds.length) return new Map();

  const inventories = await this.inventoryRepository
    .createQueryBuilder('inventory')
    .leftJoinAndSelect('inventory.category', 'category')
    .loadRelationCountAndMap(
      'inventory.assignedUnitsCount',
      'inventory.units',
      'assignedUnit',
      (qb) => qb.where('assignedUnit.isAssigned = :t', { t: true }),
    )
    .loadRelationCountAndMap(
      'inventory.availableUnitsCount',
      'inventory.units',
      'availableUnit',
      (qb) => qb.where('availableUnit.isAssigned = :f', { f: false }),
    )
    .where('category.id IN (:...categoryIds)', { categoryIds })
    .andWhere('inventory.isActive = :active', { active: true })
    .orderBy('inventory.name', 'ASC')
    .getMany();

  const map = new Map<string, Inventory[]>();
  for (const inv of inventories) {
    const catId = inv.category?.id;
    if (!catId) continue;
    if (!map.has(catId)) map.set(catId, []);
    map.get(catId)!.push(inv);
  }
  return map;
}
```

The `itemCount` column on the category is a denormalized cache — handy, but caches drift. I keep an honest count by deriving it from the loaded inventories at read time (`itemCount: inventories.length`) and added a `recalculateAllItemCounts` maintenance mutation for when the stored number gets out of sync with reality. I learned to trust the derived number and treat the column as a hint.

There's also a `searchInventoryCategories` query that does a `LIKE` over both `name` and `label`, because people search for "sim" expecting to find the category whose label is "SIM Kits" but whose machine name is `SIM_KIT`. Searching one field would have missed half the matches.

## The dialog, and the icon problem I underestimated

The frontend side is a standalone Angular dialog driven by a reactive form and signals. Name, optional label, optional icon, optional description. Most of it is unremarkable — a `FormGroup`, a submit that calls the GraphQL mutation, a snackbar on success. Two things took longer than I expected.

The first: the machine name. Users type "SIM Kits" into the name field. The database wants `SIM_KIT`-shaped identifiers. I didn't want to make them think about that, so the transform happens on submit:

```ts
const input = {
  name: this.categoryForm.get('name')?.value.toUpperCase().replace(/\s+/g, '_'),
  label: this.categoryForm.get('label')?.value,
  icon: rawIcon || 'category',
  description: this.categoryForm.get('description')?.value,
};
```

Type "SIM Kits", get `SIM_KITS` as the name and "SIM Kits" as the label. The uniqueness constraint is on the uppercased name, so "sim kits" and "SIM Kits" can't both sneak in as separate categories.

The second thing was icons, and this is where I went down a dead end. I let the icon field be a free text input, figuring people would type a Material icon name. They typed `recipt`. They typed `monitor`, which isn't a Material icon (the real one is `desktop_windows`). They typed a hyphenated guess. Every wrong value rendered as an empty box or the literal text, and the card looked broken.

The naive fix was to validate against the full Material set. The better fix was an allowlist plus a small normalize-and-alias layer, because the goal isn't to reject typos, it's to forgive them:

```ts
export function normalizeIconName(icon?: string | null): string {
  if (!icon) return '';
  return String(icon).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function aliasIconName(normalized: string): string {
  const aliasMap: Record<string, string> = {
    recipt: 'receipt_long',
    monitor: 'desktop_windows',
    screen: 'desktop_windows',
    trash: 'delete',
    cart: 'shopping_cart',
    bulb: 'lightbulb',
    // ...
  };
  return aliasMap[normalized] ?? normalized;
}
```

On submit I normalize, alias, then accept the icon if it's a known Material name, or one of the curated suggestions the picker offers. Anything that survives none of those checks gets a bottom-center error instead of a broken card:

```ts
const normalized = aliasIconName(normalizeIconName(rawIcon));
const isFromSuggestions =
  this.availableIconNames.includes(rawIcon) ||
  (normalized ? this.availableIconNames.includes(normalized) : false);
const isKnownMaterial = normalized ? guards.isKnownIcon(normalized) : false;
const isIconValid = !normalized || isKnownMaterial || isFromSuggestions;

if (!isIconValid) {
  this.categoryForm.get('icon')?.setErrors({ invalidIcon: true });
  this.notifier.handleError('Invalid icon name. Please choose a valid Material icon.');
  return;
}
```

The picker is a search-as-you-type autocomplete over a curated set grouped by theme (Inventory, Electronics, Office, Kitchen, Tools), with arrow-key navigation and a live preview card that mirrors exactly how the category will look in the grid. The preview was the highest-value piece of the whole dialog. People stopped guessing because they could see the result before saving.

One small touch that paid off out of proportion to its size: the form autosaves a draft to `localStorage` on a 300ms debounce, and restores it if the dialog reopens. Someone gets pulled away mid-create, comes back, and their half-typed category is still there.

```ts
this.formSub = this.categoryForm.valueChanges
  .pipe(debounceTime(300))
  .subscribe(() => this.saveDraft());
```

The draft is cleared on a successful create, so you never reopen the dialog to a stale ghost of a category you already made.

## The sharp edge: the old enum didn't disappear

The thing nobody warns you about when you turn an enum into a table: the enum doesn't politely vanish. `InventoryCategory` was still imported in a dozen places — the unit-creation input still describes `category` as a string field that's "required when auto-creating inventory," DTOs referenced it, and existing rows held enum string values that now had to map to category ids. I couldn't flip the relation and call it done; I had to keep the old values resolving while new categories came in through the table.

For a while both lived side by side, which is ugly but honest. New writes go through the foreign key. The migration backfilled a category row for each enum value that was actually in use, so existing items resolved to a real category instead of dangling. The ones nobody had used got quietly dropped — turns out `ACCESS_POINT` and `MEMORY_CARD` were aspirational.

If I did it again I'd seed the category table from the enum as the very first step, before touching a single resolver, and run the whole app against the table for a release while the enum sat there doing nothing. Cut the rope only once you're sure nothing's hanging from it. I was too eager to delete the enum and spent an afternoon chasing a resolver that still expected an enum-typed argument from a caller I'd forgotten about.

The other thing I'd change: I'd make `recalculateAllItemCounts` run on a schedule from the start instead of as a button someone remembers to press. A denormalized count that drifts is a denormalized count that lies, and the first time a card showed "12 items" over a list of nine, I had to explain that the number was a cache, which is never a sentence you want to say to the person who runs the warehouse.

What the team got is small and exactly right. They open a dialog, type "SIM Kits," pick an icon, and the category exists. No ticket, no deploy, no enum. The next morning someone added "Returns — Pending QA" without telling me, and I only found out because I saw it in the grid. That's the whole point. The categories are theirs now.
