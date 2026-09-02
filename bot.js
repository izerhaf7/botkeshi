import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import Pino from "pino";
import qrcode from "qrcode-terminal";
import { readFileSync, writeFileSync, existsSync } from "fs";

const CONFIG_PATH = "./config.json";

async function startBot() {
  const logger = Pino({ level: "info" });

  // ===== OWNER: SEKARANG BISA MULTI OWNER =====
  // disimpan sebagai bare-id (angka sebelum @, tanpa :9)
  /** @type {string[]} */
  let OWNER_BARES = [];

  // tempat nyimpen update list dari owner (key -> isi baru) SEMUA LOWERCASE
  let REPLIES = {};

  // helper: ambil bare id dari JID
  const getBare = (jid) => {
    if (!jid) return "";
    return jid.split("@")[0].split(":")[0];
  };

  const isOwnerBare = (bare) =>
    !!bare && Array.isArray(OWNER_BARES) && OWNER_BARES.includes(bare);

  // ====== LOAD / SAVE CONFIG PERMANEN ======
  const loadConfig = () => {
    try {
      if (existsSync(CONFIG_PATH)) {
        const rawCfg = readFileSync(CONFIG_PATH, "utf-8");
        if (rawCfg.trim().length > 0) {
          const parsed = JSON.parse(rawCfg);
          if (parsed && typeof parsed === "object") {
            // backward compatible: ownerBare (lama) -> ownerBares (baru)
            if (Array.isArray(parsed.ownerBares)) {
              OWNER_BARES = parsed.ownerBares.filter(Boolean);
            } else if (parsed.ownerBare && typeof parsed.ownerBare === "string") {
              OWNER_BARES = [parsed.ownerBare];
            }

            if (parsed.replies && typeof parsed.replies === "object") {
              REPLIES = parsed.replies;
            }
          }
        }
        console.log(
          "✅ Config loaded:",
          CONFIG_PATH,
          "| OWNER_BARES:",
          OWNER_BARES.join(",") || "(none)"
        );
      } else {
        console.log("ℹ️ Config file belum ada, mulai dari default.");
      }
    } catch (err) {
      console.error("❌ Gagal load config:", err);
    }
  };

  const saveConfig = () => {
    try {
      const data = {
        ownerBares: OWNER_BARES,
        // tulis juga ownerBare pertama untuk kompat lama (kalau ada)
        ownerBare: OWNER_BARES[0] || null,
        replies: REPLIES,
      };
      writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
      console.log("💾 Config saved:", CONFIG_PATH);
    } catch (err) {
      console.error("❌ Gagal save config:", err);
    }
  };

  // load config di awal
  loadConfig();

  // simpan session di folder "auth"
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        "== Scan QR di bawah ini pakai WhatsApp (Perangkat tertaut) =="
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("Connection closed, code:", statusCode);
      if (shouldReconnect) {
        console.log("Reconnect...");
        startBot();
      } else {
        console.log("Logged out, harus scan ulang nanti.");
      }
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp sudah konek!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg?.message || !msg.key?.remoteJid) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const sender = isGroup ? msg.key.participant : from;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    const raw = text.trim();
    const lower = raw.toLowerCase();

    const botJid = sock.user?.id || "";
    const botBare = getBare(botJid);
    const senderBare = getBare(sender);

    const isBot = msg.key.fromMe === true;
    const isOwner = isOwnerBare(senderBare);
    const isPrivileged = isBot || isOwner;

    const ctx = msg.message?.extendedTextMessage?.contextInfo || {};

    console.log(
      "Pesan dari:",
      sender,
      "| senderBare:",
      senderBare,
      "| chat:",
      from,
      "| raw:",
      raw,
      "| botJid:",
      botJid,
      "| botBare:",
      botBare,
      "| OWNER_BARES:",
      OWNER_BARES.join(",") || "(none)",
      "| isBot:",
      isBot,
      "| isOwner:",
      isOwner
    );

    // ===== HANYA RESPON DI GRUP =====
    if (!isGroup) {
      return;
    }

    // ================== OWNER MANAGEMENT ==================
    // !owners -> list owner
    if (lower === "!owners") {
      if (!isPrivileged) {
        await sock.sendMessage(
          from,
          {
            text:
              "Command *!owners* hanya bisa dipakai oleh nomor bot atau owner.",
          },
          { quoted: msg }
        );
        return;
      }

      if (!OWNER_BARES.length) {
        await sock.sendMessage(
          from,
          { text: "Belum ada owner yang terdaftar di config." },
          { quoted: msg }
        );
        return;
      }

      const lines = OWNER_BARES.map((b, i) => `${i + 1}. ${b}`).join("\n");
      await sock.sendMessage(
        from,
        {
          text:
            "*Daftar OWNER_BARES yang terdaftar:*\n" +
            lines +
            "\n\n_Catatan: ini ID internal (bare), bukan format nomor HP biasa._",
        },
        { quoted: msg }
      );
      return;
    }

    // !setowner -> reset daftar owner jadi 1 orang
    if (lower.startsWith("!setowner")) {
      // kalau belum ada owner sama sekali, pertama kali WAJIB dari nomor bot
      if (!OWNER_BARES.length) {
        if (!isBot) {
          await sock.sendMessage(
            from,
            {
              text:
                "Owner belum di-set.\n" +
                "Pertama kali pakai *!setowner* harus dari *nomor bot*.",
            },
            { quoted: msg }
          );
          return;
        }
      } else {
        // kalau sudah ada owner, cuma bot / owner yang boleh
        if (!isPrivileged) {
          await sock.sendMessage(
            from,
            {
              text:
                "Command *!setowner* hanya bisa dipakai nomor bot atau owner saat ini.",
            },
            { quoted: msg }
          );
          return;
        }
      }

      let targetJid = null;

      if (ctx.mentionedJid && ctx.mentionedJid.length > 0) {
        targetJid = ctx.mentionedJid[0];
      } else if (ctx.participant) {
        targetJid = ctx.participant;
      }

      if (!targetJid) {
        await sock.sendMessage(
          from,
          {
            text:
              "Cara pakai *!setowner*:\n" +
              "• Reply pesan calon owner lalu ketik *!setowner*, atau\n" +
              "• Mention calon owner di pesan *!setowner*.\n\n" +
              "Perintah ini akan *mereset* daftar owner menjadi hanya 1 orang (target).",
          },
          { quoted: msg }
        );
        return;
      }

      const targetBare = getBare(targetJid);

      if (!targetBare) {
        await sock.sendMessage(
          from,
          { text: "Gagal membaca ID calon owner dari reply/mention." },
          { quoted: msg }
        );
        return;
      }

      if (targetBare === botBare) {
        await sock.sendMessage(
          from,
          {
            text:
              "Tidak perlu set bot sebagai owner. Bot selalu dianggap privileged.\n" +
              "Kalau mau, pakai *!addowner* ke nomor lain.",
          },
          { quoted: msg }
        );
        return;
      }

      OWNER_BARES = [targetBare];
      saveConfig();

      await sock.sendMessage(
        from,
        {
          text:
            "Owner berhasil di-*reset*.\n\n" +
            "Sekarang daftar owner hanya:\n" +
            `• *${targetBare}*\n\n` +
            "_Catatan: ini ID internal WA (bare-id), bukan nomor HP mentah._",
        },
        { quoted: msg }
      );

      return;
    }

    // !addowner -> tambahin owner baru tanpa reset yang lama
    if (lower.startsWith("!addowner")) {
      if (!isPrivileged) {
        await sock.sendMessage(
          from,
          {
            text:
              "Command *!addowner* hanya bisa dipakai nomor bot atau owner.",
          },
          { quoted: msg }
        );
        return;
      }

      let targetJid = null;

      if (ctx.mentionedJid && ctx.mentionedJid.length > 0) {
        targetJid = ctx.mentionedJid[0];
      } else if (ctx.participant) {
        targetJid = ctx.participant;
      }

      if (!targetJid) {
        await sock.sendMessage(
          from,
          {
            text:
              "Cara pakai *!addowner*:\n" +
              "• Reply pesan calon owner lalu ketik *!addowner*, atau\n" +
              "• Mention calon owner di pesan *!addowner*.\n\n" +
              "Perintah ini akan *menambah* owner, tidak menghapus owner lain.",
          },
          { quoted: msg }
        );
        return;
      }

      const targetBare = getBare(targetJid);

      if (!targetBare) {
        await sock.sendMessage(
          from,
          { text: "Gagal membaca ID calon owner dari reply/mention." },
          { quoted: msg }
        );
        return;
      }

      if (isOwnerBare(targetBare)) {
        await sock.sendMessage(
          from,
          {
            text:
              `ID *${targetBare}* sudah terdaftar sebagai owner.\n` +
              "Tidak ada perubahan.",
          },
          { quoted: msg }
        );
        return;
      }

      if (targetBare === botBare) {
        await sock.sendMessage(
          from,
          {
            text:
              "Bot otomatis privileged, tidak perlu ditambah sebagai owner.",
          },
          { quoted: msg }
        );
        return;
      }

      OWNER_BARES.push(targetBare);
      saveConfig();

      const lines = OWNER_BARES.map((b, i) => `${i + 1}. ${b}`).join("\n");

      await sock.sendMessage(
        from,
        {
          text:
            `Owner baru berhasil ditambahkan:\n• *${targetBare}*\n\n` +
            "*Daftar owner sekarang:*\n" +
            lines,
        },
        { quoted: msg }
      );

      return;
    }

    // (optional) !delowner kalau lu nanti mau, tinggal tambah sendiri.
    // Untuk sekarang kita skip biar nggak kebanyakan fitur admin.

    // ===== ADMIN: addlist / update list / deletelist =====
    if (
      lower.startsWith("addlist") ||
      lower.startsWith("update list") ||
      lower.startsWith("deletelist")
    ) {
      if (!isPrivileged) {
        await sock.sendMessage(
          from,
          {
            text:
              "Command *addlist* / *update list* / *deletelist* hanya bisa dipakai oleh *owner* atau *nomor bot*.",
          },
          { quoted: msg }
        );
        return;
      }

      // DELETE LIST
      if (lower.startsWith("deletelist")) {
        const matchDel = raw.match(/^deletelist\s+(\S+)$/i);
        if (!matchDel) {
          await sock.sendMessage(
            from,
            {
              text:
                "Format hapus list:\n" +
                "deletelist <key>\n\n" +
                "Contoh:\n" +
                "deletelist redfinger",
            },
            { quoted: msg }
          );
          return;
        }

        const key = matchDel[1].toLowerCase();

        if (REPLIES[key]) {
          delete REPLIES[key];
          saveConfig();
          await sock.sendMessage(
            from,
            {
              text:
                `List custom dengan key *${key}* telah dihapus.\n` +
                "Kalau key ini punya teks default di bot, bot akan kembali pakai default.",
            },
            { quoted: msg }
          );
        } else {
          await sock.sendMessage(
            from,
            {
              text:
                `Tidak ada list custom dengan key *${key}*.\n` +
                "Kalau key ini punya teks default di bot, default tetap jalan.",
            },
            { quoted: msg }
          );
        }
        return;
      }

      // ADD / UPDATE LIST
      const isAdd = lower.startsWith("addlist");
      const pattern = isAdd
        ? /^addlist\s+(\S+)\s+([\s\S]+)$/i
        : /^update list\s+(\S+)\s+([\s\S]+)$/i;

      const match = raw.match(pattern);
      if (!match) {
        await sock.sendMessage(
          from,
          {
            text:
              "Format:\n" +
              (isAdd ? "addlist" : "update list") +
              " <key> <isi baru>\n\n" +
              "Contoh:\n" +
              "addlist redfinger *HARGA REDFINGER*\n" +
              "update list gamemenu *TOP UP GAME YANG TERSEDIA* ...",
          },
          { quoted: msg }
        );
        return;
      }

      const key = match[1].toLowerCase();
      const newText = match[2].trim();

      REPLIES[key] = newText;
      saveConfig();

      await sock.sendMessage(
        from,
        {
          text:
            (isAdd ? "List baru" : "List") +
            ` dengan key *${key}* berhasil disimpan.\n\n` +
            `Sekarang kalau user ketik *${key}* (atau menu yang pakai key itu), bot akan kirim isi barunya.`,
        },
        { quoted: msg }
      );
      return;
    }

    // ===== COMMAND: !me =====
    if (lower === "!me") {
      let replyText;

      if (isOwner) {
        replyText = "kamu adalah *owner*";
      } else if (isBot) {
        replyText = "ini adalah *nomor bot*";
      } else {
        replyText = "kamu *bukan owner*";
      }

      await sock.sendMessage(from, { text: replyText }, { quoted: msg });
      return;
    }

    // ========= ADMIN: !setname =========
    if (lower.startsWith("!setname")) {
      if (!isPrivileged) {
        await sock.sendMessage(
          from,
          { text: "Command *!setname* hanya bisa dipakai bot atau owner." },
          { quoted: msg }
        );
        return;
      }

      if (!isGroup) {
        await sock.sendMessage(
          from,
          { text: "Command *!setname* hanya bisa dipakai di dalam grup." },
          { quoted: msg }
        );
        return;
      }

      const newName = raw.slice("!setname".length).trim();

      if (!newName) {
        await sock.sendMessage(
          from,
          {
            text:
              "Format: *!setname NAMABARU*\n" +
              "Contoh: !setname KeshiStore Official",
          },
          { quoted: msg }
        );
        return;
      }

      if (newName.length > 100) {
        await sock.sendMessage(
          from,
          { text: "Nama grup terlalu panjang (maks 100 karakter)." },
          { quoted: msg }
        );
        return;
      }

      try {
        await sock.groupUpdateSubject(from, newName);
        await sock.sendMessage(
          from,
          { text: `Nama grup telah diubah menjadi:\n*${newName}*` },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error setname:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal mengubah nama grup. Pastikan bot adalah admin grup.",
          },
          { quoted: msg }
        );
      }

      return;
    }

    // ========= ADMIN: !kick =========
    if (lower.startsWith("!kick")) {
      if (!isPrivileged) {
        await sock.sendMessage(
          from,
          { text: "Command *!kick* hanya bisa dipakai bot atau owner." },
          { quoted: msg }
        );
        return;
      }

      if (!isGroup) {
        await sock.sendMessage(
          from,
          { text: "Command *!kick* hanya bisa dipakai di dalam grup." },
          { quoted: msg }
        );
        return;
      }

      let targets = [];

      if (ctx.mentionedJid && ctx.mentionedJid.length > 0) {
        targets = ctx.mentionedJid;
      } else if (ctx.participant) {
        targets = [ctx.participant];
      }

      if (targets.length === 0) {
        await sock.sendMessage(
          from,
          {
            text:
              "Cara pakai *!kick*:\n" +
              "• Reply pesan member yang mau di-kick, atau\n" +
              "• Mention member di pesan *!kick*.",
          },
          { quoted: msg }
        );
        return;
      }

      targets = targets.filter((jid) => {
        const bare = getBare(jid);
        return bare !== botBare && !isOwnerBare(bare);
      });

      if (targets.length === 0) {
        await sock.sendMessage(
          from,
          { text: "Nggak bisa kick bot atau owner." },
          { quoted: msg }
        );
        return;
      }

      try {
        await sock.groupParticipantsUpdate(from, targets, "remove");
        await sock.sendMessage(
          from,
          {
            text:
              "Berhasil kick:\n" + targets.map((t) => `- ${t}`).join("\n"),
          },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error kick:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal kick member. Pastikan bot adalah admin grup.",
          },
          { quoted: msg }
        );
      }

      return;
    }

    // ========= COMMAND: close / open (status grup) =========
    if (lower === "close") {
      if (!isOwner) {
        await sock.sendMessage(
          from,
          { text: "Command *close* hanya bisa dipakai oleh *owner*." },
          { quoted: msg }
        );
        return;
      }

      try {
        const meta = await sock.groupMetadata(from);
        const subject = meta.subject || "KESHI STORE";

        const clean = subject.replace(/^[❌✅]\s*/u, "");
        const newName = `❌ ${clean}`;

        await sock.groupUpdateSubject(from, newName);
        await sock.groupSettingUpdate(from, "announcement"); // hanya admin

        await sock.sendMessage(
          from,
          {
            text:
              "Grup ditutup.\n" +
              "• Nama grup diubah menjadi:\n" +
              `  *${newName}*\n` +
              "• Hanya admin yang bisa mengirim pesan.",
          },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error close group:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal menutup grup. Pastikan bot adalah admin dan bisa ubah info grup.",
          },
          { quoted: msg }
        );
      }

      return;
    }

    if (lower === "open") {
      if (!isOwner) {
        await sock.sendMessage(
          from,
          { text: "Command *open* hanya bisa dipakai oleh *owner*." },
          { quoted: msg }
        );
        return;
      }

      try {
        const meta = await sock.groupMetadata(from);
        const subject = meta.subject || "KESHI STORE";

        const clean = subject.replace(/^[❌✅]\s*/u, "");
        const newName = `✅ ${clean}`;

        await sock.groupUpdateSubject(from, newName);
        await sock.groupSettingUpdate(from, "not_announcement"); // semua member

        await sock.sendMessage(
          from,
          {
            text:
              "Grup dibuka.\n" +
              "• Nama grup diubah menjadi:\n" +
              `  *${newName}*` +
              "\n• Semua member bisa mengirim pesan.",
          },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error open group:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal membuka grup. Pastikan bot adalah admin dan bisa ubah info grup.",
          },
          { quoted: msg }
        );
      }

      return;
    }

    // ===== PANGGIL BOT =====
    if (lower === "bot") {
      await sock.sendMessage(
        from,
        { text: "iya saya di sini, apa yang bisa saya bantu?" },
        { quoted: msg }
      );
      return;
    }

    // ===== HIDE TAG (h <pesan>) =====
    if (lower.startsWith("h ")) {
      if (!isOwner) {
        await sock.sendMessage(
          from,
          { text: "Command *h* (hide tag) hanya bisa dipakai owner." },
          { quoted: msg }
        );
        return;
      }

      try {
        const meta = await sock.groupMetadata(from);
        const participants = meta.participants || [];

        const mentions = participants
          .map((p) => p.id)
          .filter((jid) => getBare(jid) !== botBare);

        const messageText = raw.slice(1).trim(); // buang huruf 'h'

        await sock.sendMessage(
          from,
          {
            text: messageText,
            mentions,
          },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error hide tag:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal melakukan hide tag. Pastikan bot masih di grup dan punya akses metadata.",
          },
          { quoted: msg }
        );
      }

      return;
    }

    // ================== LOGIKA MENU / CUSTOMER ==================

    if (lower === "menu") {
      const defaultText =
        "*MENU LAYANAN KESHISTORE*\n\n" +
        "1. Aplikasi Premium\n" +
        "2. Kebutuhan Sosmed\n" +
        "3. Top Up Game\n\n" +
        "Ketik angka / nama menu.\n" +
        "Contoh: 1 atau 'aplikasi premium'";

      const text = REPLIES.mainmenu || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "1" || lower === "aplikasi premium" || lower === "appsmenu") {
      const defaultText =
        "*APLIKASI PREMIUM YANG TERSEDIA*\n\n" +
        "- Netflix\n" +
        "- YouTube\n" +
        "- Alight Motion\n" +
        "- Canva\n" +
        "- Disney Plus / Hotstar\n" +
        "- CapCut\n" +
        "- HBO GO / Max\n" +
        "- Bstation\n" +
        "- Spotify\n" +
        "- Prime Video\n" +
        "- Gemini AI\n" +
        "- ChatGPT\n" +
        "- Vidio\n" +
        "- WeTV\n" +
        "- Viu Premium\n" +
        "- iQIYI\n\n" +
        "_Ketik nama aplikasi, contoh: netflix_";

      const text = REPLIES.appsmenu || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "netflix") {
      const defaultText = `*HARGA NETFLIX UHD+*
KeshiStore.idn Netflix UHD+

*SHARED 1 PROFIL 2 USER*
• 1 Bulan : Rp 14.500
• 3 Bulan : Rp 43.000
• 1 Tahun : Rp 170.000
_berlaku kelipatan_

*SHARED 1 PROFIL 1 DEVICE*
• 1 Bulan : Rp 24.000
• 3 Bulan : Rp 70.000
• 1 Tahun : Rp 250.000
_berlaku kelipatan_

*PRIVATE 1 PROFIL 1 USER*
_(FREE REQ NAME & PIN)_
• 1 Bulan : Rp 35.000
• 3 Bulan : Rp 100.000
_berlaku kelipatan_`;

      const text = REPLIES.netflix || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "youtube") {
      const defaultText = `*PRICE YOUTUBE PREMIUM*
KeshiStore.idn Youtube Premium ✅

*YOUTUBE INVITE* (email buyer, full garansi)
• 1 Bulan  : Rp 4.000
• 4 Bulan  : Rp 16.000
• 6 Bulan  : Rp 20.000

*YOUTUBE FAMHEAD GARANSI*
• Akun buyer 1 Bulan : Rp 12.000

*YOUTUBE INDPLAN 1x GARANSI BACKFREE*
• Akun buyer 1 Bulan : Rp 10.000

*Note:*
➥ Semua akun full garansi selagi mengikuti syarat dari Keshi
➥ Syarat klaim garansi = akun kena backfree (tidak berlaku untuk nonaktif)
➥ 1 akun maksimal join family 2x
➥ Paket 4 Bulan = 2x ganti akun, 6 Bulan = 3x ganti akun`;

      const text = REPLIES.youtube || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "alight") {
      const defaultText = `*PRICE ALIGHT MOTION*
KeshiStore.idn Alight Motion ✅

*SHARING ALL DEVICE*
• 1 Tahun : Rp 2.000

*PRIVATE ALL DEVICE*
• 1 Tahun : Rp 4.000

*Note:*
↳ Akun sudah disediakan oleh seller
↳ Sharing full garansi
↳ Private garansi 6 bulan
↳ Private bisa pakai akun dari buyer/pembeli atau dari penjual`;

      const text = REPLIES.alight || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "canva") {
      if (REPLIES.canva) {
        await sock.sendMessage(from, { text: REPLIES.canva }, { quoted: msg });
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `*PRICE CANVA PRO*
KeshiStore.idn Canva Pro ✅

*INVITE MEMBER*
• 1 Bulan  : Rp 3.000
• 1 Tahun  : Rp 10.000
• Lifetime / Selamanya : Rp 15.000

*FAMHEAD*
• 1 Bulan : Rp 6.000

*Note:*
↳ 1 Tahun garansi 6 bulan
↳ Lifetime garansi 2 tahun
↳ Auto renew
↳ Cukup kirimkan email kamu ke seller`,
        },
        { quoted: msg }
      );
      return;
    }

    if (
      lower === "disney" ||
      lower === "hotstar" ||
      lower === "disney hotstar"
    ) {
      const defaultText = `*PRICE DISNEY HOTSTAR*
KeshiStore.idn Disney Hotstar ✅

*SHARED 3 USER*
• 1 Bulan : Rp 18.000

*Note:*
↳ Akun sudah disediakan oleh seller
↳ Semua full garansi selagi masih ada durasi & garansi`;

      const text = REPLIES.disney || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "capcut") {
      const defaultText = `*PRICE CAPCUT PRO*
KeshiStore.idn Capcut Pro

*SHARING*
• 7 Hari : Rp 3.000
• 1 Bulan : Rp 8.000

*PRIVATE*
• 7 Hari : Rp 5.000
• 1 Bulan : Rp 12.000

*Note:*
↳ Sharing 1 minggu & 1 bulan full garansi
↳ Private garansi 10 hari`;

      const text = REPLIES.capcut || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (
      lower === "hbo" ||
      lower === "hbo go" ||
      lower === "hbo max"
    ) {
      const defaultText = `*PRICE HBO GO / MAX*
KeshiStore.idn HBO GO / MAX ASIA ✅

*SHARING*
• 1 Bulan : Rp 15.000
• 3 Bulan : Rp 40.000

*Note:*
↳ Semua akun full garansi selagi masih ada durasi`;

      const text = REPLIES.hbo || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "bstation") {
      const defaultText = `*PRICE BSTATION PREMIUM*
KeshiStore.idn Bstation Premium

*SHARING*
• 1 Bulan : Rp 7.000
• 1 Tahun : Rp 18.000
• Lifetime / Selamanya : Rp 80.000

*PRIVATE*
• 1 Bulan : Rp 20.000
• 1 Tahun : Rp 180.000

*Note:*
↳ Sharing 1 Tahun garansi 6 bulan
↳ Sharing Lifetime / selamanya garansi 2 tahun
↳ Semua durasi Private full garansi`;

      const text = REPLIES.bstation || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "spotify") {
      const defaultText = `*PRICE SPOTIFY PREMIUM*
KeshiStore.idn Spotify Premium ✅

*PLAN STUDENT*
• 1 Bulan : Rp 8.000`;

      const text = REPLIES.spotify || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (
      lower === "prime video" ||
      lower === "amazon prime" ||
      lower === "prime"
    ) {
      const defaultText = `*PRICE AMAZON PRIME VIDEO*
KeshiStore.idn Amazon Prime Video ✅

*SHARING*
• 1 Bulan : Rp 8.000

*PRIVATE*
• 1 Bulan : Rp 14.000

*Note:*
↳ Semua akun full garansi selagi masih ada durasi`;

      const text = REPLIES.prime || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "gemini") {
      if (REPLIES.gemini) {
        await sock.sendMessage(from, { text: REPLIES.gemini }, { quoted: msg });
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `*PRICE GEMINI AI*
KeshiStore.idn Gemini AI ✅

*GEMINI PRO INVITE* (email buyer, full garansi)
• 1 Bulan : Rp 10.000
• 4 Bulan : Rp 40.000
• 6 Bulan : Rp 50.000

*GEMINI PRO FAMHEAD GARANSI*
• Akun buyer (fresh) 1 Tahun : Rp 50.000

*Note:*
↳ Semua akun full garansi selagi mengikuti syarat dari Keshi
↳ Syarat klaim garansi = akun kena backfree (tidak berlaku untuk nonaktif)
↳ FAMHEAD 1 akun bisa invite 5 orang
↳ Pro invite cukup memberikan email, nanti di-invite oleh admin/Keshi`,
        },
        { quoted: msg }
      );
      return;
    }

   if (
      lower === "2" ||
      lower === "sosmed" ||
      lower === "sosial media" ||
      lower === "kebutuhan sosmed" ||
      lower === "sosmedmenu"
    ) {
      const defaultText = "*KEBUTUHAN SOSMED*\n" + "• TikTok\n" + "• Instagram";

      const text = REPLIES.sosmedmenu || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (
      lower === "3" ||
      lower === "top up" ||
      lower === "topup" ||
      lower === "top up game" ||
      lower === "topup game" ||
      lower === "gamesmenu" ||
      lower === "gamemenu"
    ) {
      const defaultText =
        "*TOP UP GAME YANG TERSEDIA*\n" +
        "• Mobile Legends (MLBB)\n" +
        "• Free Fire (FF)\n" +
        "• PUBG Mobile\n" +
        "• Genshin Impact\n" +
        "• Honor of Kings (HOK)\n" +
        "• Call of Duty Mobile (CODM)\n" +
        "• Valorant\n" +
        "• Dll (bisa diedit sendiri)";

      const text = REPLIES.gamemenu || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "payment") {
      const defaultText = `💸 ᴘᴀʏᴍᴇɴᴛ ᴋᴇꜱʜɪ ꜱᴛᴏʀᴇ 

E-WALLET :
DANA : 085159270066
(SESAMA DANA WAJIB +100
A/n : foto profile keshi store
GOPAY : 085159270066
A/n Keshi
QRIS KHUSUS YANG BELUM PREMIUM

BANK :
💳 MANDIRI : 1560025030174 
A/n. MUHAMAD J KARYA K
💳 BANK JAGO : 000701116078505
A/n MUHAMAD J KARYA K

note :
ⓘ topup gopay via bank WAJIB ada tambahan fee +1.000
ⓘ topup dana via bank WAJIB ada tambahan fee +500
ⓘ topup QRIS tidak ada biaya admin`;

      const text = REPLIES.payment || defaultText;
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (lower === "qris") {
      try {
        const imageBuffer = readFileSync("./assets/QRIS KESHI.JPG");
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
            caption:
              REPLIES.qris ||
              "Silakan scan QRIS ini untuk pembayaran ke Keshi Store.",
          },
          { quoted: msg }
        );
      } catch (e) {
        console.error("Error kirim QRIS:", e);
        await sock.sendMessage(
          from,
          {
            text:
              "Gagal mengirim QRIS. Cek file *QRIS KESHI.JPG* di folder *assets* (nama & path harus pas).",
          },
          { quoted: msg }
        );
      }
      return;
    }

    // ===== CUSTOM KEY LAIN (redfinger, mlbb, ff, dll) =====
    if (REPLIES[lower]) {
      const text = REPLIES[lower];
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    // ===== TANPA COMMAND → DIEM =====
    return;
  });
}

startBot().catch((err) => console.error("Error startBot:", err));
