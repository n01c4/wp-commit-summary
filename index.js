require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const axios = require("axios");
const notifier = require("node-notifier");
const path = require("path");

// ─── Structured Logging ──────────────────────────────────
function log(level, tag, msg) {
  const ts = new Date().toLocaleString("tr-TR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const line = `[${ts}] [${level.padEnd(5)}] [${tag}] ${msg}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ─── Config ───────────────────────────────────────────────
const {
  GITHUB_TOKEN,
  HF_API_TOKEN,
  WHATSAPP_GROUP_NAME,
  REPOS,
  CRON_SCHEDULE = "30 6 * * *",
  SUMMARY_LANGUAGE = "tr",
} = process.env;

const repos = REPOS.split(",").map((r) => r.trim());
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
};

// ─── Sabitler ─────────────────────────────────────────────
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;     // 5 dakika
const MAX_SEND_RETRIES = 3;                          // mesaj gönderim deneme sayısı
const REINIT_TIMEOUT_MS = 90 * 1000;                 // reinit için max bekleme
const RETRY_DELAY_MS = 10 * 1000;                    // denemeler arası bekleme
const GITHUB_RETRY_COUNT = 3;                        // GitHub API retry
const GITHUB_RETRY_DELAY_MS = 5 * 1000;              // GitHub retry arası bekleme
const HF_MAX_RETRIES = 3;                            // HF 503 retry limiti

// ─── WhatsApp State ──────────────────────────────────────
let whatsappClient = null;
let cachedGroupId = null;
let isReady = false;
let isRecovering = false;
let healthCheckTimer = null;
let lastHealthCheckTime = null;
let lastHealthCheckOk = null;
let startupTime = null;

// ─── Yardımcı: Gecikme ──────────────────────────────────
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Yardımcı: Timeout ile Promise ──────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: ${ms}ms timeout aşıldı`)), ms)
    ),
  ]);
}

// ─── GitHub: Son 24 saatteki commitleri çek ───────────────
async function getCommits(repo) {
  const since = new Date();
  since.setDate(since.getDate() - 1);
  since.setHours(6, 30, 0, 0);

  for (let attempt = 1; attempt <= GITHUB_RETRY_COUNT; attempt++) {
    try {
      log("INFO", "GitHub", `${repo}: Commitler çekiliyor (deneme ${attempt}/${GITHUB_RETRY_COUNT})...`);
      const { data } = await axios.get(
        `https://api.github.com/repos/${repo}/commits`,
        {
          headers: ghHeaders,
          params: { since: since.toISOString(), per_page: 100 },
          timeout: 30000,
        }
      );
      log("INFO", "GitHub", `${repo}: ${data.length} commit bulundu.`);
      return data;
    } catch (err) {
      log("ERROR", "GitHub", `${repo}: Hata (deneme ${attempt}/${GITHUB_RETRY_COUNT}): ${err.message}`);
      if (attempt < GITHUB_RETRY_COUNT) {
        log("INFO", "GitHub", `${repo}: ${GITHUB_RETRY_DELAY_MS / 1000}sn sonra tekrar denenecek...`);
        await delay(GITHUB_RETRY_DELAY_MS);
      }
    }
  }
  log("ERROR", "GitHub", `${repo}: Tüm denemeler başarısız.`);
  return [];
}

// ─── GitHub: Commit detayını çek ─────────────────────────
async function getCommitDetail(repo, sha) {
  const sha7 = sha.substring(0, 7);
  for (let attempt = 1; attempt <= GITHUB_RETRY_COUNT; attempt++) {
    try {
      const { data } = await axios.get(
        `https://api.github.com/repos/${repo}/commits/${sha}`,
        { headers: ghHeaders, timeout: 30000 }
      );
      return data;
    } catch (err) {
      log("ERROR", "GitHub", `Commit detay hatası ${sha7} (deneme ${attempt}/${GITHUB_RETRY_COUNT}): ${err.message}`);
      if (attempt < GITHUB_RETRY_COUNT) await delay(GITHUB_RETRY_DELAY_MS);
    }
  }
  return null;
}

// ─── Commitleri zenginleştir (dosya bilgileriyle) ─────────
async function enrichCommits(repo, commits) {
  if (!commits.length) return null;

  log("INFO", "GitHub", `${repo}: ${commits.length} commit detayı çekiliyor...`);

  const enriched = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  const allFiles = new Set();
  const mergeCommitShas = new Set();

  for (const c of commits) {
    if (c.parents && c.parents.length > 1) {
      mergeCommitShas.add(c.sha.substring(0, 7));
    }
  }

  if (mergeCommitShas.size > 0) {
    log("INFO", "GitHub", `${repo}: ${mergeCommitShas.size} merge commit atlanacak.`);
  }

  for (const c of commits) {
    const sha7 = c.sha.substring(0, 7);
    const isMerge = mergeCommitShas.has(sha7);

    if (isMerge) {
      enriched.push({
        sha: sha7,
        message: c.commit.message,
        author: c.commit.author.name,
        date: c.commit.author.date,
        files: [],
        stats: { additions: 0, deletions: 0, total: 0 },
        isMerge: true,
      });
      continue;
    }

    const detail = await getCommitDetail(repo, c.sha);
    const files = detail?.files || [];

    const fileChanges = files.map((f) => ({
      name: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));

    totalAdditions += detail?.stats?.additions || 0;
    totalDeletions += detail?.stats?.deletions || 0;
    files.forEach((f) => allFiles.add(f.filename));

    enriched.push({
      sha: sha7,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      files: fileChanges,
      stats: detail?.stats || { additions: 0, deletions: 0, total: 0 },
      isMerge: false,
    });
  }

  const finalCommits = enriched.filter((c) => !c.isMerge);

  const authorCounts = {};
  enriched.forEach((c) => {
    authorCounts[c.author] = (authorCounts[c.author] || 0) + 1;
  });

  log("INFO", "GitHub", `${repo}: Zenginleştirme tamamlandı. ${finalCommits.length} commit, ${allFiles.size} dosya, +${totalAdditions} -${totalDeletions} satır.`);

  return {
    repo,
    commits: finalCommits,
    count: finalCommits.length,
    authors: Object.entries(authorCounts)
      .map(([name, count]) => `${name} (${count} commit)`)
      .join(", "),
    authorCounts,
    totalAdditions,
    totalDeletions,
    totalFiles: allFiles.size,
  };
}

// ─── Commit verisini LLM için metin formatına dönüştür ───
function buildCommitText(repoData) {
  let text = `REPO: ${repoData.repo}\n`;
  text += `Toplam: ${repoData.count} commit, ${repoData.totalFiles} dosya değişti, +${repoData.totalAdditions} -${repoData.totalDeletions} satır\n`;
  text += `Katkıda bulunanlar: ${repoData.authors}\n\n`;

  const byDate = {};
  for (const c of repoData.commits) {
    const dateKey = new Date(c.date).toLocaleDateString("tr-TR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(c);
  }

  for (const [date, commits] of Object.entries(byDate)) {
    text += `--- ${date} ---\n`;
    for (const c of commits) {
      const msgFirstLine = c.message.split("\n")[0];
      text += `\n[${c.sha}] ${msgFirstLine}\n`;
      text += `Yazar: ${c.author}\n`;
      text += `Değişiklik: +${c.stats.additions} -${c.stats.deletions} satır, ${c.files.length} dosya\n`;

      const added = c.files.filter((f) => f.status === "added");
      const modified = c.files.filter((f) => f.status === "modified");
      const removed = c.files.filter((f) => f.status === "removed");
      const renamed = c.files.filter((f) => f.status === "renamed");

      if (added.length) {
        text += `Yeni dosyalar: ${added.map((f) => `${f.name} (+${f.additions})`).join(", ")}\n`;
      }
      if (modified.length) {
        text += `Değişen dosyalar: ${modified.map((f) => `${f.name} (+${f.additions}/-${f.deletions})`).join(", ")}\n`;
      }
      if (removed.length) {
        text += `Silinen dosyalar: ${removed.map((f) => f.name).join(", ")}\n`;
      }
      if (renamed.length) {
        text += `Yeniden adlandırılan: ${renamed.map((f) => f.name).join(", ")}\n`;
      }
    }
    text += "\n";
  }

  return text;
}

// ─── HF Inference API ile özet oluştur ────────────────────
const HF_MODEL = "Qwen/Qwen3-235B-A22B";

async function generateSummary(allRepoData, retryCount = 0) {
  const messages = buildMessages(allRepoData);

  log("INFO", "HF", `Özet oluşturuluyor (model: ${HF_MODEL}, deneme: ${retryCount + 1}/${HF_MAX_RETRIES + 1})...`);

  try {
    const { data } = await axios.post(
      "https://router.huggingface.co/v1/chat/completions",
      {
        model: HF_MODEL,
        messages,
        max_tokens: 4096,
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${HF_API_TOKEN}` },
        timeout: 120000,
      }
    );

    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content.trim();
      log("INFO", "HF", `Özet başarıyla oluşturuldu (${content.length} karakter).`);
      return content;
    }
    log("ERROR", "HF", `Beklenmeyen yanıt: ${JSON.stringify(data).slice(0, 300)}`);
    return null;
  } catch (err) {
    if (err.response?.status === 503 && retryCount < HF_MAX_RETRIES) {
      log("INFO", "HF", `Model yükleniyor (503), 30sn sonra tekrar denenecek (deneme ${retryCount + 1}/${HF_MAX_RETRIES})...`);
      await delay(30000);
      return generateSummary(allRepoData, retryCount + 1);
    }
    log("ERROR", "HF", `Hata: ${err.message} (status: ${err.response?.status || "N/A"})`);
    return null;
  }
}

function buildMessages(allRepoData) {
  const lang = SUMMARY_LANGUAGE === "tr" ? "Türkçe" : "English";

  const commitTexts = allRepoData.map((d) => buildCommitText(d)).join("\n==========\n\n");

  const totalCommits = allRepoData.reduce((s, d) => s + d.count, 0);
  const totalFiles = allRepoData.reduce((s, d) => s + d.totalFiles, 0);
  const totalAdded = allRepoData.reduce((s, d) => s + d.totalAdditions, 0);
  const totalDeleted = allRepoData.reduce((s, d) => s + d.totalDeletions, 0);

  const statsBlock = `İstatistikler: ${totalCommits} commit, ~${totalFiles} dosya değişti, +${totalAdded} -${totalDeleted} satır`;

  return [
    {
      role: "system",
      content: `Sen bir kıdemli yazılım mühendisisin. Commit verilerinden ${lang} detaylı günlük rapor yaz.

ÖNEMLİ KURALLAR:
1. Her dosyayı tek tek listeleme! Bunun yerine değişiklikleri ANLAT ve açıkla. Dosyaları grupla ve ne amaçla eklendiğini/değiştiğini yaz.
2. Anahtar dosyaları backtick içinde yaz ama her dosyayı değil, sadece önemli olanları.
3. Yeni eklenen büyük dosyalar için satır sayısını parantez içinde belirt.
4. Değişiklikleri kategorize et: Veritabanı, Backend, Frontend, Test, UI vb.

FORMAT (her commit için):

### \`{sha}\` — {ne yapıldığının kısa açıklaması}
**Yazar:** {isim}

- **Kategori adı:** Anlatımsal açıklama. Önemli dosya adları ve satır sayıları inline olarak.
- Birden fazla kategori varsa her birini ayrı madde yap.

ÖRNEK ÇIKTI:
### \`873961e\` — Excel export ve etkinlik menü navigasyon düzeltmeleri
**Yazar:** poparticularly

- **Yeni özellik — Excel Export:** \`org-orders-export.service.ts\` (710 satır) ile organizatörler için sipariş verilerini Excel'e aktarma özelliği eklendi. \`exceljs\` paketi bağımlılıklara eklendi.
- **Frontend:** Organizatör panelinde \`EventList\` bileşeninde navigasyon düzeltmeleri yapıldı.
- **API:** \`api.ts\` servis dosyasına export endpoint'leri eklendi.

RAPORUN SONUNA EKLE:

## Özet İstatistikler
| Metrik | Değer |
|--------|-------|
(toplam commit, değişen dosya, eklenen/silinen satır, katkıda bulunanlar)

## Eklenen Temel Özellikler
| Özellik | Durum |
|---------|-------|
(her önemli özellik: ✅ Yeni / 🔄 Güncelleme / 🐛 Düzeltme)`,
    },
    {
      role: "user",
      content: `${statsBlock}\n\n${commitTexts}`,
    },
  ];
}

// ─── Fallback: AI olmadan detaylı rapor ───────────────────
function buildFallbackReport(allRepoData) {
  log("INFO", "Fallback", "Ham veri raporu oluşturuluyor...");
  let report = "";

  for (const repoData of allRepoData) {
    report += `📦 *${repoData.repo}*\n`;
    report += `📊 ${repoData.count} commit | ${repoData.totalFiles} dosya | +${repoData.totalAdditions} -${repoData.totalDeletions} satır\n`;
    report += `👥 ${repoData.authors}\n\n`;

    for (const c of repoData.commits) {
      const msgFirstLine = c.message.split("\n")[0];
      const date = new Date(c.date).toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      report += `• \`${c.sha}\` ${msgFirstLine}\n`;
      report += `  _${c.author}_ (${date}) — ${c.files.length} dosya, +${c.stats.additions}/-${c.stats.deletions}\n`;

      const newFiles = c.files.filter((f) => f.status === "added");
      if (newFiles.length) {
        report += `  Yeni: ${newFiles.map((f) => f.name.split("/").pop()).join(", ")}\n`;
      }
      report += "\n";
    }
  }

  log("INFO", "Fallback", `Rapor hazır (${report.length} karakter).`);
  return report;
}

// ═══════════════════════════════════════════════════════════
// ─── WhatsApp: Sağlam bağlantı yönetimi ─────────────────
// ═══════════════════════════════════════════════════════════

function createClient() {
  log("INFO", "WhatsApp", "Yeni client oluşturuluyor...");
  return new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
      ],
    },
  });
}

function attachClientEvents(client) {
  client.on("qr", (qr) => {
    log("INFO", "WhatsApp", "QR kodu oluşturuldu — telefon ile taranması bekleniyor.");
    qrcode.generate(qr, { small: true });
    notifier.notify({
      title: "WhatsApp QR Kodu Gerekli",
      message: "Terminali aç ve QR kodu telefonunla tara!",
      sound: true,
      wait: true,
    });
  });

  client.on("loading_screen", (percent, message) => {
    log("INFO", "WhatsApp", `Yükleniyor: %${percent} — ${message}`);
  });

  client.on("authenticated", () => {
    log("INFO", "WhatsApp", "Oturum doğrulandı (session geçerli).");
  });

  client.on("ready", () => {
    isReady = true;
    isRecovering = false;
    lastHealthCheckOk = new Date();
    log("INFO", "WhatsApp", "=== BAĞLANTI HAZIR ===");
    log("INFO", "WhatsApp", `Takip edilen repolar: ${repos.join(", ")}`);
    log("INFO", "WhatsApp", `Cron: ${CRON_SCHEDULE}`);
    log("INFO", "WhatsApp", `Grup: ${WHATSAPP_GROUP_NAME}`);
  });

  client.on("auth_failure", (msg) => {
    isReady = false;
    log("ERROR", "WhatsApp", `OTURUM HATASI: ${msg}`);
    log("ERROR", "WhatsApp", "Kullanıcı telefonundan session silinmiş olabilir. QR kodu yeniden taranmalı.");
    notifier.notify({
      title: "WhatsApp Oturum Hatası",
      message: "Oturum geçersiz! Terminali aç, QR kodu yeniden tara.",
      sound: true,
      wait: true,
    });
  });

  client.on("disconnected", (reason) => {
    isReady = false;
    log("ERROR", "WhatsApp", `BAĞLANTI KOPTU: ${reason}`);
    notifier.notify({
      title: "WhatsApp Bağlantı Koptu",
      message: `Sebep: ${reason}. Otomatik kurtarma başlayacak.`,
      sound: true,
      wait: true,
    });
    // disconnected sonrası recovery healthCheck tarafından yapılacak
  });

  client.on("change_state", (state) => {
    log("INFO", "WhatsApp", `Durum değişikliği: ${state}`);
  });
}

// ─── WhatsApp: Bağlantı sağlığını kontrol et ────────────
async function healthCheck() {
  const now = new Date();
  lastHealthCheckTime = now;

  if (isRecovering) {
    log("INFO", "HealthCheck", "Recovery devam ediyor, kontrol atlanıyor.");
    return;
  }

  try {
    // getState() — Puppeteer frame'e erişir, bozuksa hata fırlatır
    const state = await withTimeout(
      whatsappClient.getState(),
      15000,
      "getState"
    );
    if (state === "CONNECTED") {
      lastHealthCheckOk = now;
      log("INFO", "HealthCheck", `OK — Durum: ${state} | Uptime: ${formatUptime()}`);
    } else {
      log("ERROR", "HealthCheck", `Beklenmeyen durum: ${state} — recovery başlatılıyor.`);
      await recoverWhatsApp("healthCheck: beklenmeyen durum " + state);
    }
  } catch (err) {
    log("ERROR", "HealthCheck", `BAŞARISIZ: ${err.message}`);
    const lastOkAgo = lastHealthCheckOk
      ? `${Math.round((now - lastHealthCheckOk) / 1000)}sn önce`
      : "hiç";
    log("ERROR", "HealthCheck", `Son başarılı kontrol: ${lastOkAgo}`);
    await recoverWhatsApp("healthCheck hatası: " + err.message);
  }
}

function formatUptime() {
  if (!startupTime) return "N/A";
  const diff = Date.now() - startupTime;
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hours}sa ${mins}dk`;
}

// ─── WhatsApp: Otomatik kurtarma ─────────────────────────
async function recoverWhatsApp(reason) {
  if (isRecovering) {
    log("INFO", "Recovery", "Zaten recovery devam ediyor, tekrar başlatılmıyor.");
    return;
  }

  isRecovering = true;
  isReady = false;
  log("INFO", "Recovery", `=== RECOVERY BAŞLADI === Sebep: ${reason}`);

  // 1) Eski client'ı yok et
  try {
    log("INFO", "Recovery", "Eski client destroy ediliyor...");
    await withTimeout(whatsappClient.destroy(), 15000, "destroy");
    log("INFO", "Recovery", "Eski client destroy edildi.");
  } catch (err) {
    log("ERROR", "Recovery", `Destroy hatası (önemsiz, devam ediliyor): ${err.message}`);
  }

  // 2) Yeni client oluştur ve başlat
  log("INFO", "Recovery", "Yeni client oluşturuluyor...");
  whatsappClient = createClient();
  attachClientEvents(whatsappClient);

  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        whatsappClient.once("ready", () => resolve());
        whatsappClient.once("auth_failure", (msg) => reject(new Error("Auth hatası: " + msg)));
        whatsappClient.initialize().catch(reject);
      }),
      REINIT_TIMEOUT_MS,
      "Recovery init"
    );
    log("INFO", "Recovery", "=== RECOVERY BAŞARILI ===");
  } catch (err) {
    isRecovering = false;
    log("ERROR", "Recovery", `Recovery başarısız: ${err.message} — sonraki healthCheck'te tekrar denenecek.`);
  }
}

// ─── WhatsApp: Bağlantı hazır olana kadar bekle ─────────
async function ensureWhatsAppReady() {
  if (isReady) {
    // Ek güvenlik: gerçekten çalışıyor mu kontrol et
    try {
      const state = await withTimeout(whatsappClient.getState(), 10000, "ensureReady-getState");
      if (state === "CONNECTED") {
        log("INFO", "WhatsApp", "ensureReady: Bağlantı doğrulandı (CONNECTED).");
        return true;
      }
      log("ERROR", "WhatsApp", `ensureReady: Durum CONNECTED değil (${state}), recovery başlatılıyor.`);
    } catch (err) {
      log("ERROR", "WhatsApp", `ensureReady: getState hatası: ${err.message}, recovery başlatılıyor.`);
    }
    // Buraya düştüyse bağlantı aslında bozuk
    await recoverWhatsApp("ensureReady: bağlantı doğrulanamadı");
  }

  if (!isReady) {
    log("INFO", "WhatsApp", "ensureReady: Bağlantı hazır değil, recovery başlatılıyor...");
    if (!isRecovering) {
      await recoverWhatsApp("ensureReady: isReady=false");
    } else {
      // Recovery zaten çalışıyor, bitmesini bekle
      log("INFO", "WhatsApp", "ensureReady: Recovery zaten çalışıyor, bitmesi bekleniyor...");
      const waitStart = Date.now();
      while (!isReady && Date.now() - waitStart < REINIT_TIMEOUT_MS) {
        await delay(1000);
      }
    }
  }

  if (isReady) {
    log("INFO", "WhatsApp", "ensureReady: Bağlantı hazır.");
    return true;
  }

  log("ERROR", "WhatsApp", "ensureReady: Bağlantı sağlanamadı.");
  return false;
}

// ─── WhatsApp: Mesaj gönder (agresif retry ile) ─────────
async function sendWhatsAppMessage(message) {
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    log("INFO", "Gönderim", `=== GÖNDERIM DENEMESİ ${attempt}/${MAX_SEND_RETRIES} ===`);

    // Her denemede bağlantıyı doğrula
    const ready = await ensureWhatsAppReady();
    if (!ready) {
      log("ERROR", "Gönderim", `Deneme ${attempt}: WhatsApp bağlantısı sağlanamadı.`);
      if (attempt < MAX_SEND_RETRIES) {
        log("INFO", "Gönderim", `${RETRY_DELAY_MS / 1000}sn sonra tekrar denenecek...`);
        await delay(RETRY_DELAY_MS);
      }
      continue;
    }

    try {
      let group;
      if (cachedGroupId) {
        log("INFO", "Gönderim", `Cache'den grup çekiliyor: ${cachedGroupId}`);
        group = await withTimeout(whatsappClient.getChatById(cachedGroupId), 30000, "getChatById");
      } else {
        log("INFO", "Gönderim", "Chat listesi çekiliyor (ilk sefer)...");
        const chats = await withTimeout(whatsappClient.getChats(), 120000, "getChats");
        log("INFO", "Gönderim", `${chats.length} chat bulundu, grup aranıyor: "${WHATSAPP_GROUP_NAME}"`);
        group = chats.find((c) => c.name === WHATSAPP_GROUP_NAME && c.isGroup);
        if (!group) {
          const groupNames = chats.filter((c) => c.isGroup).map((c) => c.name);
          log("ERROR", "Gönderim", `GRUP BULUNAMADI: "${WHATSAPP_GROUP_NAME}"`);
          log("ERROR", "Gönderim", `Mevcut gruplar (${groupNames.length}): ${groupNames.join(", ")}`);
          return false;
        }
        cachedGroupId = group.id._serialized;
        log("INFO", "Gönderim", `Grup ID cache'lendi: ${cachedGroupId}`);
      }

      log("INFO", "Gönderim", `Grup: "${group.name}" (${group.id._serialized}). Mesaj gönderiliyor (${message.length} karakter)...`);
      await withTimeout(group.sendMessage(message), 30000, "sendMessage");
      log("INFO", "Gönderim", `=== MESAJ BAŞARIYLA GÖNDERİLDİ === Grup: ${WHATSAPP_GROUP_NAME}`);
      return true;
    } catch (err) {
      log("ERROR", "Gönderim", `Deneme ${attempt} BAŞARISIZ: ${err.message}`);

      // Frame/session hataları — recovery yap
      if (
        err.message.includes("detached") ||
        err.message.includes("frame") ||
        err.message.includes("Target closed") ||
        err.message.includes("Session closed") ||
        err.message.includes("Protocol error") ||
        err.message.includes("timeout")
      ) {
        log("INFO", "Gönderim", "Puppeteer/bağlantı hatası tespit edildi, recovery başlatılıyor...");
        await recoverWhatsApp("sendMessage hatası: " + err.message);
      }

      if (attempt < MAX_SEND_RETRIES) {
        log("INFO", "Gönderim", `${RETRY_DELAY_MS / 1000}sn sonra tekrar denenecek...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  log("ERROR", "Gönderim", `=== TÜM DENEMELER BAŞARISIZ (${MAX_SEND_RETRIES}/${MAX_SEND_RETRIES}) === MESAJ GÖNDERİLEMEDİ!`);
  notifier.notify({
    title: "MESAJ GÖNDERİLEMEDİ!",
    message: `${MAX_SEND_RETRIES} deneme sonrası mesaj gönderilemedi. Kontrol edin!`,
    sound: true,
    wait: true,
  });
  return false;
}

// ─── Ana akış ─────────────────────────────────────────────
async function runDailyReport() {
  const reportId = Date.now().toString(36);
  log("INFO", "Rapor", `=== GÜNLÜK RAPOR BAŞLIYOR === (id: ${reportId})`);

  // 1) Tüm repoların commitlerini çek ve zenginleştir
  const allRepoData = [];
  for (const repo of repos) {
    const commits = await getCommits(repo);
    if (!commits.length) {
      log("INFO", "Rapor", `${repo}: Yeni commit yok.`);
      continue;
    }
    const enriched = await enrichCommits(repo, commits);
    if (enriched) allRepoData.push(enriched);
  }

  if (!allRepoData.length) {
    log("INFO", "Rapor", "Hiçbir repoda yeni commit yok, mesaj gönderilmeyecek.");
    return;
  }

  const totalCommits = allRepoData.reduce((s, d) => s + d.count, 0);
  log("INFO", "Rapor", `Toplam ${totalCommits} commit bulundu (${allRepoData.length} repo). Özet oluşturuluyor...`);

  // 2) HF ile özet oluştur
  let summary = await generateSummary(allRepoData);

  if (!summary) {
    log("INFO", "Rapor", "HF özeti oluşturulamadı, fallback rapor kullanılacak.");
    summary = buildFallbackReport(allRepoData);
  }

  // 3) WhatsApp'a gönder
  const today = new Date().toLocaleDateString("tr-TR");
  const repoNames = allRepoData.map((d) => d.repo).join(", ");
  const header = `🤖 *Günlük Commit Özeti*\n📅 ${today}\n📋 ${repoNames}\n${"─".repeat(30)}\n\n`;
  const message = header + summary;

  log("INFO", "Rapor", `Mesaj hazır (${message.length} karakter). Gönderiliyor...`);
  const sent = await sendWhatsAppMessage(message);

  if (sent) {
    log("INFO", "Rapor", `=== RAPOR TAMAMLANDI === (id: ${reportId})`);
  } else {
    log("ERROR", "Rapor", `=== RAPOR BAŞARISIZ — MESAJ GÖNDERİLEMEDİ === (id: ${reportId})`);
  }
}

// ─── Başlatma ─────────────────────────────────────────────
function startBot() {
  startupTime = Date.now();
  log("INFO", "Bot", "═══════════════════════════════════════════");
  log("INFO", "Bot", "      WhatsApp Commit Bot Başlatılıyor     ");
  log("INFO", "Bot", "═══════════════════════════════════════════");
  log("INFO", "Bot", `Repolar: ${repos.join(", ")}`);
  log("INFO", "Bot", `Cron: ${CRON_SCHEDULE}`);
  log("INFO", "Bot", `Grup: ${WHATSAPP_GROUP_NAME}`);
  log("INFO", "Bot", `Dil: ${SUMMARY_LANGUAGE}`);
  log("INFO", "Bot", `HF Model: ${HF_MODEL}`);
  log("INFO", "Bot", `Health check aralığı: ${HEALTH_CHECK_INTERVAL_MS / 1000}sn`);
  log("INFO", "Bot", `Gönderim retry: ${MAX_SEND_RETRIES} deneme`);
  log("INFO", "Bot", `Recovery timeout: ${REINIT_TIMEOUT_MS / 1000}sn`);

  whatsappClient = createClient();
  attachClientEvents(whatsappClient);

  // İlk ready'de cron ve health check başlat
  whatsappClient.once("ready", () => {
    // Cron job
    cron.schedule(CRON_SCHEDULE, () => {
      log("INFO", "Cron", "=== CRON TETİKLENDİ ===");
      runDailyReport().catch((err) => {
        log("ERROR", "Cron", `runDailyReport YAKALANMAMIŞ HATA: ${err.message}`);
        log("ERROR", "Cron", err.stack);
      });
    });
    log("INFO", "Bot", `Cron job aktif: ${CRON_SCHEDULE}`);

    // Periyodik health check
    healthCheckTimer = setInterval(() => {
      healthCheck().catch((err) => {
        log("ERROR", "HealthCheck", `YAKALANMAMIŞ HATA: ${err.message}`);
      });
    }, HEALTH_CHECK_INTERVAL_MS);
    log("INFO", "Bot", `Health check aktif: her ${HEALTH_CHECK_INTERVAL_MS / 60000} dakikada bir.`);

    // Test modu
    if (process.argv.includes("--test")) {
      log("INFO", "Bot", "Test modu aktif — rapor 3sn sonra gönderilecek.");
      setTimeout(() => {
        runDailyReport().catch((err) => {
          log("ERROR", "Test", `Test raporu hatası: ${err.message}`);
          log("ERROR", "Test", err.stack);
        });
      }, 3000);
    } else {
      log("INFO", "Bot", "Cron beklemede. Test için: node index.js --test");
    }
  });

  whatsappClient.initialize().catch((err) => {
    log("ERROR", "Bot", `İlk başlatma hatası: ${err.message}`);
    log("ERROR", "Bot", "5sn sonra tekrar denenecek...");
    setTimeout(() => startBot(), 5000);
  });
}

// ─── Graceful shutdown ───────────────────────────────────
process.on("SIGINT", async () => {
  log("INFO", "Bot", "SIGINT alındı, kapatılıyor...");
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  try {
    await whatsappClient.destroy();
    log("INFO", "Bot", "WhatsApp client kapatıldı.");
  } catch (_) {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("INFO", "Bot", "SIGTERM alındı, kapatılıyor...");
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  try {
    await whatsappClient.destroy();
    log("INFO", "Bot", "WhatsApp client kapatıldı.");
  } catch (_) {}
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("ERROR", "Bot", `UNCAUGHT EXCEPTION: ${err.message}`);
  log("ERROR", "Bot", err.stack);
  // Crash etme, çalışmaya devam et
});

process.on("unhandledRejection", (reason) => {
  log("ERROR", "Bot", `UNHANDLED REJECTION: ${reason}`);
  // Crash etme, çalışmaya devam et
});

// ─── Başlat ───────────────────────────────────────────────
startBot();
