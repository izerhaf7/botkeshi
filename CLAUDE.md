# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

KeshiStore WhatsApp bot: a single-file Node.js (ESM) bot built on `@whiskeysockets/baileys`. It answers customers in WhatsApp **groups** with product price lists for an Indonesian digital-goods store (premium apps, social media services, game top-ups) and gives owners some group admin commands. User-facing strings and code comments are in Indonesian. Keep new ones in Indonesian too.

## Commands

- `npm install`: install dependencies
- `npm start` (`node bot.js`): run the bot. On first run (or after logout) it prints a QR code in the terminal. Scan it from WhatsApp → Linked Devices.

There is no build step, linter, or test suite.

## Runtime state (gitignored, not in the repo)

- `auth/`: Baileys multi-file session credentials (`useMultiFileAuthState("auth")`). If you delete it, you have to scan the QR again.
- `config.json`: persistent bot state, read at startup and rewritten by `saveConfig()` whenever owners or replies change:
  - `ownerBares`: list of owner "bare IDs" (the part of the JID before `@` and `:`; these are WhatsApp internal/LID IDs, not phone numbers)
  - `ownerBare`: the first owner, still written for backward compatibility
  - `replies`: lowercase key → custom reply text

## Architecture (`bot.js`)

Everything lives inside `startBot()`. On a non-logout disconnect, `startBot()` calls itself again, which creates a new socket and reloads the config.

The `messages.upsert` handler is one long chain of `if` blocks. The first match sends a reply and `return`s, so **order matters**. Private chats are ignored completely (`if (!isGroup) return`).

Order of the dispatch chain:
1. Owner management: `!owners`, `!setowner` (resets the owner list to one person; the very first one must be sent from the bot's own number), `!addowner`. Targets come from the first mention or from the replied-to message's participant (`contextInfo`).
2. List editing: `addlist <key> <text>`, `update list <key> <text>`, `deletelist <key>`. These write to `REPLIES` and save the config.
3. `!me`, `!setname`, `!kick`, `close`/`open` (prefixes the group name with ❌/✅ and switches announcement mode), `bot`, `h <msg>` (hidetag: mentions all participants).
4. Menu and product keywords (`menu`, `1`/`2`/`3`, `netflix`, `youtube`, `payment`, `qris`, …). Each one has a hardcoded default text that `REPLIES[<key>]` overrides. Several aliases can map to one key (e.g. `disney`/`hotstar` → `REPLIES.disney`, `menu` → `REPLIES.mainmenu`).
5. Fallback: any message that exactly matches a `REPLIES` key gets that text. Otherwise the bot stays silent.

Permission levels:
- `isBot`: `msg.key.fromMe`
- `isOwner`: the sender's bare ID is in `OWNER_BARES`
- `isPrivileged`: `isBot || isOwner`

Most admin commands need `isPrivileged`. `close`, `open`, and `h` need `isOwner` specifically. Group actions also only work if the bot account is a group admin.

To add a new product, add an `if` block before the `REPLIES[lower]` fallback, following the existing `REPLIES.<key> || defaultText` pattern. For a text-only item, owners can also just use `addlist` at runtime without any code change.

## Gotchas

- `sharp` isn't imported in `bot.js`, but don't remove it: Baileys loads it as an optional peer dependency to generate image thumbnails (e.g. for the `qris` image).
- `REPLIES` is a null-prototype object (`Object.create(null)`), so keyword lookups like `REPLIES[lower]` can't hit `Object.prototype` properties (`constructor`, `__proto__`). Keep it that way when you reassign it.
