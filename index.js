require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

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
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  REPOS,
  CRON_SCHEDULE = "30 6 * * *",
  SUMMARY_LANGUAGE = "tr",
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  log("ERROR", "Bot", "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID .env'de tanımlı değil. Çıkılıyor.");
  process.exit(1);
}

const repos = REPOS.split(",").map((r) => r.trim());
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
};

// ─── Sabitler ─────────────────────────────────────────────
const MAX_SEND_RETRIES = 3;                          // Telegram gönderim deneme sayısı
const RETRY_DELAY_MS = 5 * 1000;                     // denemeler arası bekleme
const GITHUB_RETRY_COUNT = 3;                        // GitHub API retry
const GITHUB_RETRY_DELAY_MS = 5 * 1000;              // GitHub retry arası bekleme
const HF_MAX_RETRIES = 3;                            // HF 503 retry limiti
const TELEGRAM_MAX_LEN = 4096;                       // Telegram mesaj karakter limiti

// ─── Yardımcı: Gecikme ──────────────────────────────────
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    report += `📦 ${repoData.repo}\n`;
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
      report += `• ${c.sha} ${msgFirstLine}\n`;
      report += `  ${c.author} (${date}) — ${c.files.length} dosya, +${c.stats.additions}/-${c.stats.deletions}\n`;

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
// ─── Telegram: Mesaj gönderim ───────────────────────────
// ═══════════════════════════════════════════════════════════

// Mesajı 4096 karakter limitine göre satır sınırlarında parçala
function splitMessage(text, maxLen = TELEGRAM_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Önce çift newline (paragraph) sınırı dene
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.substring(0, cut).trimEnd());
    remaining = remaining.substring(cut).replace(/^\s+/, "");
  }
  return chunks;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const chunks = splitMessage(text);
  log("INFO", "Telegram", `Mesaj ${chunks.length} parçaya bölündü (toplam ${text.length} karakter).`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let sent = false;

    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
      try {
        log("INFO", "Telegram", `Parça ${i + 1}/${chunks.length} gönderiliyor (${chunk.length} karakter, deneme ${attempt}/${MAX_SEND_RETRIES})...`);
        await axios.post(
          url,
          {
            chat_id: TELEGRAM_CHAT_ID,
            text: chunk,
            disable_web_page_preview: true,
          },
          { timeout: 30000 }
        );
        log("INFO", "Telegram", `Parça ${i + 1}/${chunks.length} gönderildi.`);
        sent = true;
        break;
      } catch (err) {
        const desc = err.response?.data?.description || err.message;
        const status = err.response?.status || "N/A";
        log("ERROR", "Telegram", `Parça ${i + 1} deneme ${attempt} BAŞARISIZ: ${desc} (status: ${status})`);
        if (attempt < MAX_SEND_RETRIES) {
          log("INFO", "Telegram", `${RETRY_DELAY_MS / 1000}sn sonra tekrar denenecek...`);
          await delay(RETRY_DELAY_MS);
        }
      }
    }

    if (!sent) {
      log("ERROR", "Telegram", `=== PARÇA ${i + 1}/${chunks.length} GÖNDERİLEMEDİ — RAPOR EKSİK KALDI ===`);
      return false;
    }
  }

  log("INFO", "Telegram", `=== TÜM MESAJ BAŞARIYLA GÖNDERİLDİ === chat_id: ${TELEGRAM_CHAT_ID}`);
  return true;
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

  // 3) Telegram'a gönder
  const today = new Date().toLocaleDateString("tr-TR");
  const repoNames = allRepoData.map((d) => d.repo).join(", ");
  const header = `🤖 Günlük Commit Özeti\n📅 ${today}\n📋 ${repoNames}\n${"─".repeat(30)}\n\n`;
  const message = header + summary;

  log("INFO", "Rapor", `Mesaj hazır (${message.length} karakter). Gönderiliyor...`);
  const sent = await sendTelegramMessage(message);

  if (sent) {
    log("INFO", "Rapor", `=== RAPOR TAMAMLANDI === (id: ${reportId})`);
  } else {
    log("ERROR", "Rapor", `=== RAPOR BAŞARISIZ — MESAJ GÖNDERİLEMEDİ === (id: ${reportId})`);
  }
}

// ─── Başlatma ─────────────────────────────────────────────
function startBot() {
  log("INFO", "Bot", "═══════════════════════════════════════════");
  log("INFO", "Bot", "      Telegram Commit Bot Başlatılıyor     ");
  log("INFO", "Bot", "═══════════════════════════════════════════");
  log("INFO", "Bot", `Repolar: ${repos.join(", ")}`);
  log("INFO", "Bot", `Cron: ${CRON_SCHEDULE} (Europe/Istanbul)`);
  log("INFO", "Bot", `Telegram chat_id: ${TELEGRAM_CHAT_ID}`);
  log("INFO", "Bot", `Dil: ${SUMMARY_LANGUAGE}`);
  log("INFO", "Bot", `HF Model: ${HF_MODEL}`);
  log("INFO", "Bot", `Gönderim retry: ${MAX_SEND_RETRIES} deneme`);

  // Cron job
  cron.schedule(CRON_SCHEDULE, () => {
    log("INFO", "Cron", "=== CRON TETİKLENDİ ===");
    runDailyReport().catch((err) => {
      log("ERROR", "Cron", `runDailyReport YAKALANMAMIŞ HATA: ${err.message}`);
      log("ERROR", "Cron", err.stack);
    });
  }, { timezone: "Europe/Istanbul" });
  log("INFO", "Bot", `Cron job aktif: ${CRON_SCHEDULE}`);

  // Test modu
  if (process.argv.includes("--test")) {
    log("INFO", "Bot", "Test modu aktif — rapor hemen gönderilecek.");
    runDailyReport().catch((err) => {
      log("ERROR", "Test", `Test raporu hatası: ${err.message}`);
      log("ERROR", "Test", err.stack);
    });
  } else {
    log("INFO", "Bot", "Cron beklemede. Test için: node index.js --test");
  }
}

// ─── Graceful shutdown ───────────────────────────────────
process.on("SIGINT", () => {
  log("INFO", "Bot", "SIGINT alındı, kapatılıyor...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("INFO", "Bot", "SIGTERM alındı, kapatılıyor...");
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
