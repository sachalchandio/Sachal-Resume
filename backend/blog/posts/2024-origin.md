---
title: "Standing up Telelinkz: the first entities, the first filter, and a Xfinity pipeline"
description: "The origin story. I bootstrapped the NestJS/GraphQL backend and an Angular dashboard from nothing, modeled the core sales domain, and got the first real"
date: "2024-07-31"
updated: "2024-07-31"
kind: "monthly"
category: "Monthly"
tags: ["nestjs", "graphql", "angular", "xfinity", "foundations"]
month: "2024-07"
repo: "both"
author: "Sachal Chandio"
stats_commits: 122
stats_backend: 45
stats_frontend: 77
---

The origin story. I bootstrapped the NestJS/GraphQL backend and an Angular dashboard from nothing, modeled the core sales domain, and got the first real provider — Xfinity — flowing end to end.

## From empty repo to a working API

This was the ground floor. I got a NestJS/GraphQL backend up and running, then spent the first stretch modeling the sales domain — entities for every actor and artifact, resolver methods across the board, and the relations that tie them together. The trickiest call early on was making sale stages and comments polymorphic instead of leaning on hard foreign keys, so a comment could attach to anything.

- Core entities plus resolvers for the whole sales domain
- Polymorphic relation for sale stages and comments
- An evolving enum layer to encode real-world sale shapes

## The Xfinity vertical, end to end

Xfinity was the proving ground for the whole pattern. I built a dedicated DTO with properly formatted dates and a fully functional filter and search on the backend, then wired an Angular screen with a router outlet so managers could filter the data — including name search by agent — and actually see results.

- XfinityDTO with formatted dates
- Working filter + agent name search
- Angular import flow that renders the data as a live table

## The first dashboard

On the frontend I scaffolded the Angular app and the first version of the Telelinkz dashboard — graphs that only appear once data is imported, a homepage with the primary navigation, and the Excel-style data view cleaned up for readability. Rough around the edges, but it was the skeleton everything else grew on.

- First dashboard with data-driven graphs
- Excel-style data view
