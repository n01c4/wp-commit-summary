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
  GROQ_API_KEY,
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
const GROQ_MAX_RETRIES = 2;                          // Groq 429/503 retry limiti (model başına)
const TELEGRAM_MAX_LEN = 4096;                       // Telegram mesaj karakter limiti

// ─── Yardımcı: Gecikme ──────────────────────────────────
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Yardımcı: Telegram HTML escape / strip ─────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripHtmlTags(s) {
  return String(s)
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

// ─── Groq API ile özet oluştur ────────────────────────────
// Birincil: Kimi K2 (Türkçe ve narrative kalitesi yüksek, Qwen3 davranışına yakın)
// Yedek:    Llama 3.3 70B (Groq'ta her zaman erişilebilir, aynı API key)
const GROQ_PRIMARY_MODEL = "moonshotai/kimi-k2-instruct";
const GROQ_FALLBACK_MODEL = "llama-3.3-70b-versatile";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(model, messages, retryCount = 0) {
  log("INFO", "Groq", `Özet oluşturuluyor (model: ${model}, deneme: ${retryCount + 1}/${GROQ_MAX_RETRIES + 1})...`);

  try {
    const { data } = await axios.post(
      GROQ_ENDPOINT,
      {
        model,
        messages,
        max_tokens: 4096,
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        timeout: 120000,
      }
    );

    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content.trim();
      log("INFO", "Groq", `Özet başarıyla oluşturuldu (${content.length} karakter, model: ${model}).`);
      return content;
    }
    log("ERROR", "Groq", `Beklenmeyen yanıt (${model}): ${JSON.stringify(data).slice(0, 300)}`);
    return null;
  } catch (err) {
    const status = err.response?.status;
    // 429 (rate limit) ve 503 (servis dolu) → kısa beklemeyle tekrar dene
    if ((status === 429 || status === 503) && retryCount < GROQ_MAX_RETRIES) {
      const wait = status === 429 ? 60000 : 10000;
      log("INFO", "Groq", `${status} alındı (${model}), ${wait / 1000}sn sonra tekrar denenecek...`);
      await delay(wait);
      return callGroq(model, messages, retryCount + 1);
    }
    log("ERROR", "Groq", `Hata (${model}): ${err.message} (status: ${status || "N/A"})`);
    return null;
  }
}

async function generateSummary(allRepoData) {
  const messages = buildMessages(allRepoData);

  // 1) Birincil model: Kimi K2
  const primary = await callGroq(GROQ_PRIMARY_MODEL, messages);
  if (primary) return primary;

  // 2) Yedek model: Llama 3.3 70B (aynı API key, ücretsiz, sıfır maliyet)
  log("INFO", "Groq", `Birincil model (${GROQ_PRIMARY_MODEL}) başarısız, yedek modele geçiliyor: ${GROQ_FALLBACK_MODEL}`);
  const fallback = await callGroq(GROQ_FALLBACK_MODEL, messages);
  return fallback;
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

ÇIKTI FORMATI: TELEGRAM HTML. SADECE şu HTML tag'lerini kullan:
- <b>kalın</b>
- <i>italik</i>
- <code>inline kod</code>

KESİNLİKLE YASAK:
- Markdown ASLA kullanma: **, ##, ###, ---, |, [], () dahil
- HTML tablo, ul/li, h1-h6, br, p, div tag'leri YASAK
- Yeni satır için sadece düz \\n karakteri kullan
- Metnin içinde geçen < > & karakterlerini KULLANMA (HTML escape gerektirir, mesaj kırılır)

İÇERİK KURALLARI:
1. Her dosyayı tek tek listeleme! Değişiklikleri ANLAT, kategorize et, gruplandır.
2. Önemli dosya adlarını <code>...</code> içine al, hepsini değil sadece anahtar olanları.
3. Yeni eklenen büyük dosyalar için satır sayısını parantez içinde belirt.
4. Değişiklikleri kategorize et: Veritabanı, Backend, Frontend, API, Test, UI, DevOps vb.

HER COMMIT İÇİN FORMAT:

<b>● {sha} — {kısa açıklama}</b>
👤 <i>{yazar}</i>

• <b>Kategori:</b> Anlatımsal açıklama. Önemli dosyalar inline <code>filename</code> şeklinde.
• Birden fazla kategori varsa her birini ayrı satırda • ile madde yap.

ÖRNEK ÇIKTI:

<b>● 873961e — Excel export ve etkinlik menü navigasyon düzeltmeleri</b>
👤 <i>poparticularly</i>

• <b>Yeni özellik — Excel Export:</b> <code>org-orders-export.service.ts</code> (710 satır) ile organizatörler için sipariş verilerini Excel'e aktarma eklendi. <code>exceljs</code> paketi bağımlılıklara eklendi.
• <b>Frontend:</b> Organizatör panelinde <code>EventList</code> bileşeninde navigasyon düzeltmeleri yapıldı.
• <b>API:</b> <code>api.ts</code> servis dosyasına export endpoint'leri eklendi.

RAPORUN SONUNA TABLO DEĞİL, MADDE LİSTESİ EKLE:

<b>📊 ÖZET İSTATİSTİKLER</b>
• Toplam commit: X
• Değişen dosya: Y
• Eklenen satır: +A
• Silinen satır: -B
• Katkıda bulunanlar: ...

<b>✨ EKLENEN TEMEL ÖZELLİKLER</b>
• ✅ {yeni özellik}
• 🔄 {güncelleme}
• 🐛 {düzeltme}`,
    },
    {
      role: "user",
      content: `${statsBlock}\n\n${commitTexts}`,
    },
  ];
}

// ─── Fallback: AI olmadan detaylı rapor (Telegram HTML) ──
function buildFallbackReport(allRepoData) {
  log("INFO", "Fallback", "Ham veri raporu oluşturuluyor...");
  let report = "";

  for (const repoData of allRepoData) {
    report += `📦 <b>${escapeHtml(repoData.repo)}</b>\n`;
    report += `📊 ${repoData.count} commit | ${repoData.totalFiles} dosya | +${repoData.totalAdditions} -${repoData.totalDeletions} satır\n`;
    report += `👥 ${escapeHtml(repoData.authors)}\n\n`;

    for (const c of repoData.commits) {
      const msgFirstLine = c.message.split("\n")[0];
      const date = new Date(c.date).toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      report += `• <code>${c.sha}</code> ${escapeHtml(msgFirstLine)}\n`;
      report += `  <i>${escapeHtml(c.author)}</i> (${date}) — ${c.files.length} dosya, +${c.stats.additions}/-${c.stats.deletions}\n`;

      const newFiles = c.files.filter((f) => f.status === "added");
      if (newFiles.length) {
        report += `  Yeni: ${escapeHtml(newFiles.map((f) => f.name.split("/").pop()).join(", "))}\n`;
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

async function sendTelegramMessage(text, parseMode = "HTML") {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const chunks = splitMessage(text);
  log("INFO", "Telegram", `Mesaj ${chunks.length} parçaya bölündü (toplam ${text.length} karakter, parse_mode=${parseMode || "none"}).`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let sent = false;

    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
      try {
        log("INFO", "Telegram", `Parça ${i + 1}/${chunks.length} gönderiliyor (${chunk.length} karakter, deneme ${attempt}/${MAX_SEND_RETRIES})...`);
        const payload = {
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          disable_web_page_preview: true,
        };
        if (parseMode) payload.parse_mode = parseMode;
        await axios.post(url, payload, { timeout: 30000 });
        log("INFO", "Telegram", `Parça ${i + 1}/${chunks.length} gönderildi.`);
        sent = true;
        break;
      } catch (err) {
        const desc = err.response?.data?.description || err.message;
        const status = err.response?.status || "N/A";
        log("ERROR", "Telegram", `Parça ${i + 1} deneme ${attempt} BAŞARISIZ: ${desc} (status: ${status})`);

        // HTML parse hatası → tüm mesajı strip edip plain text olarak baştan dene
        if (parseMode === "HTML" && status === 400) {
          log("INFO", "Telegram", "HTML parse hatası tespit edildi — tag'ler temizlenip plain text olarak yeniden gönderilecek.");
          return await sendTelegramMessage(stripHtmlTags(text), null);
        }

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

  // 2) Groq ile özet oluştur (Kimi K2 → Llama 3.3 70B fallback)
  let summary = await generateSummary(allRepoData);

  if (!summary) {
    log("INFO", "Rapor", "Groq özeti oluşturulamadı, ham veri raporu kullanılacak.");
    summary = buildFallbackReport(allRepoData);
  }

  // 3) Telegram'a gönder
  const today = new Date().toLocaleDateString("tr-TR");
  const repoNames = allRepoData.map((d) => d.repo).join(", ");
  const header = `🤖 <b>Günlük Commit Özeti</b>\n📅 ${today}\n📋 ${escapeHtml(repoNames)}\n${"─".repeat(30)}\n\n`;
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
  log("INFO", "Bot", `Groq birincil model: ${GROQ_PRIMARY_MODEL}`);
  log("INFO", "Bot", `Groq yedek model:    ${GROQ_FALLBACK_MODEL}`);
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
