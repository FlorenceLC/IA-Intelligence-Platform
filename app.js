/* =========================================
   IA INTELLIGENCE PLATFORM — app.js
   Full MVP: Import, Pipeline, Validation,
   Veille, Analyse, Chat RAG, Export
   ========================================= */

// ============ STATE ============
let state = {
  articles: [],
  rssFeeds: [],        // { id, url, name, lastFetch, enabled }
  settings: {
    mistralKey: '',
    inoreaderToken: '',
    duplicateThreshold: 82,
    sensitivity: 'normal',
    rssAutoFetch: true,
    lastAutoFetch: null
  },
  currentDuplicateCheck: null,
  chatHistory: []
};

const DOMAIN_ICONS = {
  'Défense': '🛡',
  'Civil': '🏛',
  'Entreprise': '🏢',
  'Hardware': '💻',
  'AI technologie': '🤖',
  'Robotique': '🦾',
  'Juridique': '⚖'
};

const DOMAIN_COLORS = {
  'Défense': '#f87171',
  'Civil': '#60a5fa',
  'Entreprise': '#34d399',
  'Hardware': '#a78bfa',
  'AI technologie': '#4a9eff',
  'Robotique': '#fbbf24',
  'Juridique': '#f472b6'
};

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  initNavigation();

  if (state.articles.length === 0 && !localStorage.getItem('ia_platform_initialized')) {
    injectDemoData();
    localStorage.setItem('ia_platform_initialized', '1');
  }

  renderAllViews();
  updateStats();
  updateConnectionStatus();

  // RSS auto-fetch si activé
  scheduleRssAutoFetch();

  // Sync Gist en arrière-plan APRES que l'UI est prête, uniquement si configuré
  if (gistConfigured()) {
    setTimeout(() => syncNow(true), 1500);
  }
});

function loadFromStorage() {
  try {
    const saved = localStorage.getItem('ia_platform_data');
    if (saved) {
      const parsed = JSON.parse(saved);
      state.articles   = parsed.articles   || [];
      state.rssFeeds   = parsed.rssFeeds   || [];
      state.chatHistory = parsed.chatHistory || [];
      if (parsed.settings) state.settings = { ...state.settings, ...parsed.settings };
    }
  } catch(e) {}
}

function saveToStorage() {
  try {
    localStorage.setItem('ia_platform_data', JSON.stringify(state));
  } catch(e) {}
  // Sync Gist différée 3s après chaque sauvegarde
  if (gistConfigured()) syncAfterChange();
}

function syncAfterChange() {
  clearTimeout(syncAfterChange._timer);
  syncAfterChange._timer = setTimeout(() => syncNow(true), 3000);
}

// ============ NAVIGATION ============
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

const TAB_META = {
  import:     { title: 'Import & Gestion',           subtitle: 'Importez et gérez vos articles de veille' },
  veille:     { title: 'Veille Stratégique',          subtitle: 'Votre intelligence organisée par domaine' },
  validation: { title: 'Validation Humaine',           subtitle: 'Contrôlez et validez les articles importés' },
  analyse:    { title: 'Analyse & Tendances',          subtitle: 'Visualisez vos données de veille' },
  chat:       { title: 'Interroger la Veille',         subtitle: 'Chat IA sur votre base de connaissance (RAG)' },
  export:     { title: 'Export',                       subtitle: 'Confluence, Newsletter, JSON' },
  rss:        { title: 'Flux RSS',                     subtitle: 'Abonnements automatiques à des sources IA' },
  settings:   { title: 'Paramètres',                  subtitle: 'Configuration API et préférences' }
};

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  const meta = TAB_META[tab];
  if (meta) {
    document.getElementById('page-title').textContent = meta.title;
    document.getElementById('page-subtitle').textContent = meta.subtitle;
  }
  if (tab === 'veille') renderVeille();
  if (tab === 'analyse') renderAnalyse();
  if (tab === 'settings') { renderSettings(); renderGistSettings(); }
  if (tab === 'rss') renderRssTab();
  if (tab === 'export') { renderNewsletterWeekSelector(); renderConfluenceWeekSelector(); }
}

// ============ IMPORT ============
async function importArticle() {
  const url = document.getElementById('article-url').value.trim();
  const domainSelect = document.getElementById('article-domain').value;

  if (!url) {
    showToast('⚠ Entrez l\'URL de l\'article', 'warning');
    return;
  }

  // Validate URL format
  try { new URL(url); } catch(e) {
    showToast('⚠ URL invalide — vérifiez le format https://...', 'warning');
    return;
  }

  if (!state.settings.mistralKey) {
    showToast('⚠ Configurez votre clé API Mistral dans Paramètres', 'warning');
    switchTab('settings');
    return;
  }

  showLoading('Extraction et analyse de l\'article...');

  try {
    // Step 1: Fetch page content via allorigins proxy (CORS bypass)
    let pageText = '';
    let pageTitle = '';
    let extractedPubDate = null; // extracted directly from HTML meta tags

    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      if (resp.ok) {
        const data = await resp.json();
        const html = data.contents || '';

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

        // ── Extract publication date directly from HTML meta tags ──
        const dateCandidates = [
          // JSON-LD
          html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
          html.match(/"date_published"\s*:\s*"([^"]+)"/i)?.[1],
          // OG / meta tags
          html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)?.[1],
          html.match(/content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i)?.[1],
          html.match(/name=["']pubdate["'][^>]*content=["']([^"']+)["']/i)?.[1],
          html.match(/name=["']publish_date["'][^>]*content=["']([^"']+)["']/i)?.[1],
          html.match(/name=["']date["'][^>]*content=["']([^"']+)["']/i)?.[1],
          // <time> tags
          html.match(/<time[^>]*datetime=["']([^"']+)["']/i)?.[1],
          // Microdata
          html.match(/itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i)?.[1],
          html.match(/itemprop=["']datePublished["'][^>]*datetime=["']([^"']+)["']/i)?.[1],
        ].filter(Boolean);

        for (const candidate of dateCandidates) {
          try {
            const d = new Date(candidate);
            if (!isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() <= new Date().getFullYear() + 1) {
              extractedPubDate = d.toISOString();
              break;
            }
          } catch(e) {}
        }

        // Strip HTML tags and extract readable text
        pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/\s{3,}/g, ' ')
          .trim()
          .substring(0, 4000);
      }
    } catch(fetchErr) {
      console.warn('Fetch page failed:', fetchErr.message);
    }

    // Step 2: Build article object
    const now = new Date();
    const articleData = {
      id: generateId(),
      url: url,
      title: pageTitle || url,
      titleFr: '',
      content: pageText,
      domain: domainSelect || '',
      status: 'NEW',
      date: now.toISOString(),
      publicationDate: extractedPubDate,
      week: extractedPubDate ? getWeekNumber(new Date(extractedPubDate)) : getWeekNumber(now),
      weekYear: extractedPubDate ? getWeekYear(new Date(extractedPubDate)) : getWeekYear(now),
      month: extractedPubDate
        ? new Date(extractedPubDate).toLocaleString('fr-FR', { month: 'long', year: 'numeric' })
        : now.toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: false,
      summary: '',
      keyPoints: []
    };

    // Step 3: Mistral extracts everything
    showLoading('Génération du résumé avec Mistral...');
    const result = await generateSummaryWithMistral(articleData);
    articleData.titleFr   = result.titleFr   || pageTitle || 'Article sans titre';
    articleData.title     = articleData.titleFr;
    articleData.summary   = result.summary   || '';
    articleData.keyPoints = result.keyPoints || [];
    articleData.defenseTable = result.defenseTable || null;
    if (result.domain) articleData.domain = result.domain;
    if (!articleData.domain) articleData.domain = detectDomain(articleData.titleFr + ' ' + articleData.summary);

    // Use pub date: HTML extraction wins over Mistral (more reliable), Mistral is fallback
    if (!articleData.publicationDate && result.publicationDate) {
      try {
        const d = new Date(result.publicationDate);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
          articleData.publicationDate = d.toISOString();
          articleData.week    = getWeekNumber(d);
          articleData.weekYear = getWeekYear(d);
          articleData.month   = d.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
        }
      } catch(e) {}
    }

    // Step 4: Duplicate check
    const duplicate = findDuplicate(articleData);
    if (duplicate) {
      articleData.status = 'DUPLICATE_SUSPECTED';
      state.currentDuplicateCheck = { new: articleData, existing: duplicate.article, score: duplicate.score };
      state.articles.push(articleData);
      saveToStorage();
      hideLoading();
      showDuplicateModal(articleData, duplicate.article, duplicate.score);
      return;
    }

    // Step 5: Pending review
    articleData.status = 'PENDING_REVIEW';
    state.articles.push(articleData);
    saveToStorage();
    hideLoading();
    renderSavedArticles();
    renderValidationQueue();
    updateStats();
    showToast('✅ Article importé — en attente de validation', 'success');
    clearImportForm();

  } catch(err) {
    hideLoading();
    const msg = err.message || 'Erreur inconnue';
    if (msg.includes('401')) showToast('❌ Clé API Mistral invalide ou expirée', 'error');
    else if (msg.includes('429')) showToast('❌ Limite de taux API atteinte — réessayez dans un moment', 'error');
    else if (msg.includes('timeout') || msg.includes('abort')) showToast('⚠ Délai dépassé — l\'article a quand même été traité', 'warning');
    else showToast('❌ Erreur : ' + msg, 'error');
  }
}

// ============ MISTRAL API ============
async function generateSummaryWithMistral(article) {
  const prompt = buildSummaryPrompt(article);

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.settings.mistralKey}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Tu es un expert en veille stratégique IA. Tu extrais et résumes des articles en français.
RÉPONDS UNIQUEMENT avec un objet JSON valide, sans markdown, sans backticks, sans texte avant ou après.
Structure JSON obligatoire :
{
  "titleFr": "titre de l'article traduit/reformulé en français",
  "summary": "résumé en 1 à 2 phrases claires en français",
  "keyPoints": ["👩🏻‍🚀 point 1", "🦠 point 2", "🪐 point 3"],
  "domain": "un seul parmi : Défense, Civil, Entreprise, Hardware, AI technologie, Robotique, Juridique",
  "publicationDate": "date de publication au format YYYY-MM-DD UNIQUEMENT si elle est explicitement écrite dans le contenu fourni, sinon null"
}
Les keyPoints doivent contenir entre 3 et 10 éléments, chacun commençant par un emoji.
RÈGLE STRICTE sur publicationDate : tu ne dois JAMAIS deviner, estimer ou inventer une date. Cherche UNIQUEMENT une date explicitement présente dans le texte (balises meta article:published_time, datePublished, pubdate, <time datetime>, ou une date écrite en clair comme "12 janvier 2025"). Si aucune date explicite n'est trouvée dans le contenu fourni, tu DOIS répondre null — ne propose jamais la date du jour ni une date approximative basée sur le contexte.`
        },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Mistral API ${response.status}: ${errBody.substring(0, 100)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
    if (!parsed.titleFr) parsed.titleFr = article.title || 'Article sans titre';
    if (!parsed.summary) parsed.summary = 'Résumé non disponible';
    if (!Array.isArray(parsed.keyPoints) || parsed.keyPoints.length === 0) {
      parsed.keyPoints = ['👩🏻‍🚀 Contenu extrait automatiquement'];
    }
  } catch(e) {
    parsed = {
      titleFr: article.title || 'Article sans titre',
      summary: text.substring(0, 300) || 'Résumé non disponible',
      keyPoints: ['👩🏻‍🚀 Résumé généré depuis l\'URL'],
      domain: article.domain || 'AI technologie',
      publicationDate: null
    };
  }

  // ── Extraction dédiée du tableau IA militaire si domaine = Défense ──
  parsed.defenseTable = null;
  const effectiveDomain = parsed.domain || article.domain;
  if (effectiveDomain === 'Défense') {
    try {
      parsed.defenseTable = await extractDefenseTable(article);
    } catch(e) {
      console.warn('Extraction tableau Défense échouée:', e.message);
    }
  }

  return parsed;
}

// ── Appel Mistral dédié, focalisé uniquement sur l'extraction du tableau IA militaire ──
async function extractDefenseTable(article) {
  const content = article.content
    ? article.content.substring(0, 4000)
    : `Titre : ${article.title}\nURL : ${article.url}`;

  const userPrompt = `Titre : ${article.title}\n\nContenu :\n${content}`;

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.settings.mistralKey}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant spécialisé en veille documentaire sur l'intelligence artificielle. Tu analyses des articles pour identifier s'ils parlent d'un produit, système ou technologie intégrant de l'IA.

Tâche :
À partir du texte fourni, tu dois :

1. Déterminer si le document parle d'intelligence artificielle appliquée à un produit, système ou technologie concret.
   - Si non, réponds UNIQUEMENT avec ce JSON : {"hasAI": false, "items": []}

2. Si oui, extrais TOUTES les informations suivantes pour CHAQUE produit/système/technologie IA mentionné (une entrée par produit) :
   - fabricant : nom du fabricant ou de l'organisation
   - produit : nom du produit ou de la technologie
   - fonctionIA : la fonction de l'IA décrite en UNE phrase précise
   - anneeSortie : année à partir de laquelle le produit sera/est livré, SI mentionnée explicitement dans le texte. Ce n'est PAS forcément l'année de publication de l'article. Si non mentionnée : "non précisé"
   - statut : un seul parmi "Existant" (commercialisé ou déjà utilisé), "En cours de développement" (annoncé ou en phase de test), "Concept" (idée, prototype ou vision non confirmée comme en développement)
   - categorie : un seul parmi "C4I" (système intégré de commandement/contrôle/communication/renseignement en temps réel), "Fonctions" (l'IA ajoute une fonctionnalité à un système sans en être le cœur — amélioration, assistance, automatisation partielle), "Système d'armes" (plateforme ou système militaire utilisant l'IA pour des fonctions opérationnelles, de ciblage, de décision ou d'autonomie)

Règles strictes :
- Si une information n'est pas disponible dans le texte, indique "non précisé" (jamais null, jamais inventé)
- S'il y a plusieurs produits IA mentionnés, crée une entrée par produit
- Tout doit être rédigé entièrement en français
- Ne JAMAIS inventer un fabricant, un produit ou une année qui n'est pas dans le texte

RÉPONDS UNIQUEMENT avec un JSON valide, sans markdown, sans backticks :
{"hasAI": true, "items": [{"fabricant": "...", "produit": "...", "fonctionIA": "...", "anneeSortie": "...", "statut": "...", "categorie": "..."}]}
ou
{"hasAI": false, "items": []}`
        },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) throw new Error(`Mistral API ${response.status}`);

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);

  if (!result.hasAI || !Array.isArray(result.items) || result.items.length === 0) {
    return [];
  }

  // Normaliser les champs pour l'affichage existant
  return result.items.map(item => ({
    fabricant:   item.fabricant   || 'non précisé',
    produit:     item.produit     || 'non précisé',
    fonctionIA:  item.fonctionIA  || 'non précisé',
    anneeSortie: item.anneeSortie || 'non précisé',
    statut:      item.statut      || 'non précisé',
    categorie:   item.categorie   || 'non précisé'
  }));
}

function buildSummaryPrompt(article) {
  let prompt = `Analyse cet article de veille IA et génère le JSON demandé.\n\n`;
  prompt += `URL : ${article.url}\n\n`;
  if (article.title && article.title !== article.url) {
    prompt += `Titre détecté : ${article.title}\n\n`;
  }
  if (article.content && article.content.length > 50) {
    prompt += `Contenu extrait de la page :\n${article.content.substring(0, 3500)}\n`;
  } else {
    prompt += `(Aucun contenu extrait — base-toi sur l'URL et le titre pour inférer le sujet.)\n`;
  }
  prompt += `\nGénère le JSON de résumé en français.`;
  return prompt;
}

// ============ DOMAIN DETECTION (fallback local) ============
function detectDomain(text) {
  const lower = text.toLowerCase();
  const rules = [
    { domain: 'Défense', keywords: ['défense', 'militaire', 'armée', 'drone', 'missile', 'soldat', 'combat', 'warfare', 'weapon', 'army', 'navy', 'air force', 'otan', 'nato'] },
    { domain: 'Juridique', keywords: ['loi', 'réglementation', 'regulation', 'gdpr', 'rgpd', 'juridique', 'legal', 'directive', 'tribunal', 'justice', 'droit', 'compliance', 'act', 'legislation'] },
    { domain: 'Hardware', keywords: ['puce', 'chip', 'processeur', 'gpu', 'nvidia', 'intel', 'hardware', 'semiconducteur', 'quantum', 'ordinateur', 'cpu', 'datacenter'] },
    { domain: 'Robotique', keywords: ['robot', 'bras robotique', 'automation', 'automatisation', 'humanoid', 'humanoïde', 'boston dynamics', 'cobalt'] },
    { domain: 'Civil', keywords: ['gouvernement', 'public', 'service public', 'état', 'municipal', 'national', 'agence', 'administratif', 'ministère', 'préfecture'] },
    { domain: 'Entreprise', keywords: ['startup', 'entreprise', 'business', 'marché', 'investissement', 'levée de fonds', 'financement', 'revenue', 'croissance', 'client'] },
    { domain: 'AI technologie', keywords: ['ia', 'ai', 'llm', 'gpt', 'chatgpt', 'claude', 'mistral', 'gemini', 'modèle', 'openai', 'anthropic', 'deep learning', 'machine learning'] }
  ];

  let bestMatch = { domain: 'AI technologie', score: 0 };
  for (const rule of rules) {
    const score = rule.keywords.filter(k => lower.includes(k)).length;
    if (score > bestMatch.score) bestMatch = { domain: rule.domain, score };
  }
  return bestMatch.domain;
}

// ============ DUPLICATE DETECTION ============
function findDuplicate(newArticle) {
  // 1. Exact URL match — always a duplicate
  if (newArticle.url) {
    const urlDup = state.articles.find(a =>
      a.id !== newArticle.id &&
      a.status !== 'REJECTED' &&
      a.url && normalizeUrl(a.url) === normalizeUrl(newArticle.url)
    );
    if (urlDup) return { article: urlDup, score: 100 };
  }

  // 2. Content similarity (only if both have meaningful text)
  const threshold = state.settings.duplicateThreshold / 100;
  for (const existing of state.articles) {
    if (existing.id === newArticle.id) continue;
    if (existing.status === 'REJECTED') continue;
    const score = computeSimilarity(newArticle, existing);
    if (score >= threshold) {
      return { article: existing, score: Math.round(score * 100) };
    }
  }
  return null;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove utm params, trailing slashes, fragment
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch(e) { return url.toLowerCase().trim(); }
}

function computeSimilarity(a, b) {
  // Use title + summary for comparison (content is too noisy and large)
  const titleA = normalizeText((a.titleFr || a.title || ''));
  const titleB = normalizeText((b.titleFr || b.title || ''));
  const sumA   = normalizeText(a.summary || '');
  const sumB   = normalizeText(b.summary || '');

  // Title similarity weighted more heavily
  const titleSim = jaccardSimilarity(titleA, titleB);
  const sumSim   = (sumA && sumB) ? jaccardSimilarity(sumA, sumB) : 0;

  // Weighted average: 70% title, 30% summary
  return sumA && sumB
    ? titleSim * 0.7 + sumSim * 0.3
    : titleSim;
}

function normalizeText(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûüç\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(' ').filter(w => w.length > 3));
  const setB = new Set(b.split(' ').filter(w => w.length > 3));
  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ============ VALIDATION ============
function renderValidationQueue() {
  const queue = state.articles.filter(a =>
    a.status === 'PENDING_REVIEW' || a.status === 'DUPLICATE_SUSPECTED' || a.status === 'NEW'
  );
  const container = document.getElementById('validation-queue');
  const badge = document.getElementById('validation-badge');
  const pendingCount = document.getElementById('pending-count');

  badge.textContent = queue.length;
  if (pendingCount) pendingCount.textContent = `${queue.length} en attente`;

  if (queue.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>Aucun article en attente de validation</p></div>`;
    return;
  }

  container.innerHTML = queue.map(article => `
    <div class="validation-item" id="val-${article.id}">
      <div class="validation-info">
        <div class="validation-title">${escHtml(article.titleFr || article.title)}</div>
        <div class="validation-meta">
          <span class="domain-badge ${domainClass(article.domain)}">${DOMAIN_ICONS[article.domain] || ''} ${article.domain}</span>
          <span class="status-badge ${statusClass(article.status)}">${statusLabel(article.status)}</span>
          <span style="${article.publicationDate ? '' : 'color:var(--warning)'}">${publicationDateLabel(article)}</span>
          ${article.status === 'DUPLICATE_SUSPECTED' ? `<span style="color:var(--warning)">⚠ Doublon</span>` : ''}
        </div>
      </div>
      <div class="validation-actions">
        ${article.status === 'DUPLICATE_SUSPECTED'
          ? `<button class="val-btn val-btn-warning" onclick="reopenDuplicateModal('${article.id}')">⚠ Doublon</button>`
          : ''}
        <button class="val-btn val-btn-success" onclick="validateArticle('${article.id}')">✅ Valider</button>
        <button class="val-btn val-btn-secondary" onclick="openArticleModal('${article.id}')">👁 Voir</button>
        <button class="val-btn val-btn-danger" onclick="rejectArticleById('${article.id}')">❌ Rejeter</button>
      </div>
    </div>
  `).join('');
}

function validateArticle(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  article.status = 'VALIDATED';
  saveToStorage();
  renderValidationQueue();
  renderSavedArticles();
  renderVeilleIfActive();
  updateStats();
  showToast('✅ Article validé avec succès', 'success');
}

function unvalidateArticle(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  article.status = 'PENDING_REVIEW';
  article.favorite = false;
  saveToStorage();
  renderVeille();
  renderValidationQueue();
  renderSavedArticles();
  updateStats();
  showToast('↩ Article remis en attente de validation', 'warning');
}

// Capitaliser = marquer comme traité/exporté et masquer de la veille
function capitaliseArticle(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;

  // Animation de disparition immédiate
  const card = document.getElementById(`veille-card-${id}`);
  if (card) {
    card.style.transition = 'opacity 0.3s, transform 0.3s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(20px)';
    setTimeout(() => { card.remove(); }, 300);
  }

  // Suppression définitive de la base (pas juste un changement de statut)
  state.articles = state.articles.filter(a => a.id !== id);

  // Push immédiat vers Gist pour répercuter sur tous les appareils
  _pushToSupabase();

  // Sauvegarde locale immédiate
  try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}

  updateStats();
  showToast('✓ Article capitalisé et supprimé définitivement', 'success');
}

function deleteArticleFromVeille(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  const title = (article.titleFr || article.title || '').substring(0, 50);
  if (!confirm(`Supprimer définitivement :\n« ${title} » ?`)) return;
  state.articles = state.articles.filter(a => a.id !== id);
  saveToStorage();
  renderVeille();
  renderSavedArticles();
  updateStats();
  showToast('🗑 Article supprimé', 'warning');
}

function rejectArticleById(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  article.status = 'REJECTED';
  saveToStorage();
  renderValidationQueue();
  renderSavedArticles();
  updateStats();
  showToast('❌ Article rejeté', 'warning');
}

function reopenDuplicateModal(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article || !state.currentDuplicateCheck) {
    // Try to find a match
    const dup = findDuplicateForExisting(article);
    if (dup) {
      showDuplicateModal(article, dup.article, dup.score);
    }
    return;
  }
  const { new: newA, existing, score } = state.currentDuplicateCheck;
  showDuplicateModal(newA, existing, score);
}

function findDuplicateForExisting(article) {
  const others = state.articles.filter(a => a.id !== article.id && a.status !== 'REJECTED');
  let best = null;
  for (const other of others) {
    const score = Math.round(computeSimilarity(article, other) * 100);
    if (score >= state.settings.duplicateThreshold && (!best || score > best.score)) {
      best = { article: other, score };
    }
  }
  return best;
}

// ============ DUPLICATE MODAL ============
function showDuplicateModal(newArticle, existingArticle, score) {
  document.getElementById('current-article-preview').innerHTML = `
    <strong>${escHtml(newArticle.titleFr || newArticle.title)}</strong><br>
    <small style="color:${newArticle.publicationDate ? 'var(--text-muted)' : 'var(--warning)'}">${publicationDateLabel(newArticle)}</small><br><br>
    ${escHtml((newArticle.summary || '').substring(0, 200))}
  `;
  document.getElementById('suspect-article-preview').innerHTML = `
    <strong>${escHtml(existingArticle.titleFr || existingArticle.title)}</strong><br>
    <small style="color:${existingArticle.publicationDate ? 'var(--text-muted)' : 'var(--warning)'}">${publicationDateLabel(existingArticle)}</small><br><br>
    ${escHtml((existingArticle.summary || '').substring(0, 200))}
  `;
  document.getElementById('similarity-score').textContent = score + '%';
  document.getElementById('duplicate-modal').classList.remove('hidden');
  switchTab('validation');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function validateAsNew() {
  if (!state.currentDuplicateCheck) return;
  const article = state.currentDuplicateCheck.new;
  article.status = 'PENDING_REVIEW';
  saveToStorage();
  closeModal('duplicate-modal');
  renderValidationQueue();
  showToast('✅ Article conservé comme nouveau', 'success');
}

function mergeDuplicateArticles() {
  if (!state.currentDuplicateCheck) return;
  const { new: newA, existing } = state.currentDuplicateCheck;
  // Fusionne points clés (dédupliqués) et résumé
  const combinedPoints = [...(existing.keyPoints || []), ...(newA.keyPoints || [])];
  const uniquePoints = [...new Set(combinedPoints)].slice(0, 10);

  const merged = {
    ...existing,
    keyPoints: uniquePoints,
    summary: existing.summary || newA.summary || '',
    // Conserver la date de publication la plus fiable (non vide en priorité)
    publicationDate: existing.publicationDate || newA.publicationDate || null,
    status: 'VALIDATED',
    updatedAt: new Date().toISOString()
  };
  const idx = state.articles.findIndex(a => a.id === existing.id);
  if (idx !== -1) state.articles[idx] = merged;
  // Supprimer le doublon nouvellement ajouté
  state.articles = state.articles.filter(a => a.id !== newA.id);
  state.currentDuplicateCheck = null;
  saveToStorage();
  closeModal('duplicate-modal');
  renderSavedArticles();
  renderValidationQueue();
  renderVeilleIfActive();
  updateStats();
  showToast('🔁 Articles fusionnés avec succès', 'success');
}

function rejectArticle() {
  if (!state.currentDuplicateCheck) return;
  const article = state.currentDuplicateCheck.new;
  article.status = 'REJECTED';
  state.currentDuplicateCheck = null;
  saveToStorage();
  closeModal('duplicate-modal');
  renderValidationQueue();
  renderSavedArticles();
  showToast('❌ Article rejeté', 'warning');
}

function editArticle() {
  closeModal('duplicate-modal');
  showToast('✏ Ouvrez l\'article pour le modifier', 'info');
}

// ============ FAVORITES ============
function toggleFavorite(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  article.favorite = !article.favorite;
  saveToStorage();
  renderSavedArticles();
  renderFeaturedArticles();
  renderVeilleIfActive();
  showToast(article.favorite ? '⭐ Ajouté aux favoris' : '☆ Retiré des favoris', 'success');
}

function renderFeaturedArticles() {
  const favorites = state.articles.filter(a => a.favorite && a.status !== 'REJECTED');
  const container = document.getElementById('featured-articles');
  if (!container) return;
  if (favorites.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⭐</div><p>Aucun favori</p><span>Marquez des articles avec ⭐</span></div>`;
    return;
  }
  container.innerHTML = favorites.map(a => renderArticleCard(a)).join('');
}

// ============ RENDER ARTICLES ============
let savedArticlesPage = 0;
const ARTICLES_PER_PAGE = 10;

function renderSavedArticles(page = 0) {
  savedArticlesPage = page;
  const domainFilter = document.getElementById('filter-domain')?.value || '';
  const statusFilter = document.getElementById('filter-status')?.value || '';
  // Affiche tous les articles sauf REJECTED et CAPITALISED
  let articles = state.articles.filter(a => a.status !== 'REJECTED' && a.status !== 'CAPITALISED');
  if (domainFilter) articles = articles.filter(a => a.domain === domainFilter);
  if (statusFilter) articles = articles.filter(a => a.status === statusFilter);

  // Sort newest first (by import date)
  articles.sort((a, b) => new Date(b.date) - new Date(a.date));

  const total = articles.length;
  const totalPages = Math.ceil(total / ARTICLES_PER_PAGE);
  const pageArticles = articles.slice(page * ARTICLES_PER_PAGE, (page + 1) * ARTICLES_PER_PAGE);

  const container = document.getElementById('saved-articles');
  if (!container) return;

  if (articles.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Aucun article</p><span>Importez votre premier article</span></div>`;
    renderFeaturedArticles();
    return;
  }

  const paginationHtml = totalPages > 1 ? `
    <div class="pagination">
      <button class="btn-secondary small" onclick="renderSavedArticles(${page - 1})" ${page === 0 ? 'disabled' : ''}>← Précédent</button>
      <span class="page-info">${page + 1} / ${totalPages} <span style="color:var(--text-muted)">(${total} articles)</span></span>
      <button class="btn-secondary small" onclick="renderSavedArticles(${page + 1})" ${page >= totalPages - 1 ? 'disabled' : ''}>Suivant →</button>
    </div>
  ` : `<div style="padding:8px 16px;font-size:11px;color:var(--text-muted)">${total} article${total > 1 ? 's' : ''}</div>`;

  container.innerHTML = paginationHtml + pageArticles.map(a => renderArticleCard(a)).join('') + (totalPages > 1 ? paginationHtml : '');
  renderFeaturedArticles();
}

function renderArticleCard(a) {
  const isFav = a.favorite;
  const displayDate = publicationDateLabel(a);
  return `
    <div class="article-card">
      <div class="article-card-header">
        <div class="article-card-title" onclick="openArticleModal('${a.id}')">${escHtml(a.titleFr || a.title)}</div>
        <div class="article-card-actions">
          <button class="action-btn ${isFav ? 'favorited' : ''}" onclick="toggleFavorite('${a.id}')" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '⭐' : '☆'}</button>
          <button class="action-btn" onclick="openArticleModal('${a.id}')" title="Voir">👁</button>
          <button class="action-btn" onclick="deleteArticle('${a.id}')" title="Supprimer">🗑</button>
        </div>
      </div>
      <div class="article-card-meta">
        <span class="domain-badge ${domainClass(a.domain)}">${DOMAIN_ICONS[a.domain] || ''} ${a.domain || 'Non classé'}</span>
        <span class="status-badge ${statusClass(a.status)}">${statusLabel(a.status)}</span>
        <span class="article-date" style="${a.publicationDate ? '' : 'color:var(--warning)'}">${displayDate}</span>
        ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" style="font-size:11px;color:var(--accent)">🔗 Source</a>` : ''}
      </div>
      ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : ''}
    </div>
  `;
}

// Suppression définitive — sync immédiate vers Supabase
function deleteArticle(id) {
  if (!confirm('Supprimer définitivement cet article ?')) return;
  _hardDelete(id);
}

function deleteArticleFromVeille(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  const title = (article.titleFr || article.title || '').substring(0, 60);
  if (!confirm(`Supprimer définitivement :\n« ${title} » ?`)) return;
  _hardDelete(id);
}

function _hardDelete(id) {
  state.articles = state.articles.filter(a => a.id !== id);
  // Sauvegarde locale immédiate
  try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}
  // Push immédiat vers Supabase (pas de debounce — on veut que ce soit instantané)
  _pushToSupabase();
  // Refresh UI
  renderSavedArticles();
  renderValidationQueue();
  renderVeille();
  updateStats();
  showToast('🗑 Article supprimé sur tous les appareils', 'warning');
}

// Push direct sans merge (écrase le remote avec l'état local courant)
async function _pushToSupabase() {
  try {
    const now = new Date().toISOString();
    state.articles.forEach(a => { a.updatedAt = a.updatedAt || a.date; });
    await sbFetch('/rest/v1/ia_platform', {
      method:  'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify([
        { user_id: sb.userId, data_type: 'articles',  payload: { articles: state.articles }, updated_at: now },
        { user_id: sb.userId, data_type: 'rss_feeds', payload: { feeds: state.rssFeeds },    updated_at: now }
      ])
    });
    state.settings.lastSyncDate = now;
    updateSyncUI(true);
  } catch(e) {
    console.error('Push error:', e);
  }
}

function filterArticles() { renderSavedArticles(0); }

// ============ ARTICLE MODAL ============
function openArticleModal(id) {
  const a = state.articles.find(x => x.id === id);
  if (!a) return;
  document.getElementById('modal-article-title').textContent = a.titleFr || a.title;
  document.getElementById('modal-article-body').innerHTML = buildArticleDetail(a);
  document.getElementById('article-modal').classList.remove('hidden');
}

function buildArticleDetail(a) {
  const keyPointsHtml = (a.keyPoints && a.keyPoints.length > 0)
    ? `<ul style="margin:8px 0 0 16px">${a.keyPoints.map(p => `<li style="margin-bottom:4px">${escHtml(p)}</li>`).join('')}</ul>`
    : '';

  const dateLabel = publicationDateLabel(a, false);
  // Valeur ISO (YYYY-MM-DD) pour pré-remplir l'input date, vide si non précisée
  const dateInputValue = a.publicationDate ? a.publicationDate.substring(0, 10) : '';

  const summaryBlock = `
    <div class="summary-block">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <h3 style="flex:1">${escHtml(a.titleFr || a.title)}</h3>
        <button class="btn-secondary small" onclick="copyArticleSummary('${a.id}', this)" title="Copier le résumé" style="flex-shrink:0">📋 Copier</button>
      </div>
      ${a.url ? `<p style="margin:6px 0 4px"><a href="${escHtml(a.url)}" target="_blank" style="color:var(--accent)">🔗 Lire en ligne</a> <span style="color:var(--text-muted);font-size:12px">| ${dateLabel}</span></p>` : `<p style="margin:6px 0 4px;color:var(--text-muted);font-size:12px">${dateLabel}</p>`}
      <button class="action-btn" onclick="toggleDateEdit('${a.id}')" title="Modifier la date" style="font-size:11px;margin-bottom:10px">✏ Modifier la date</button>
      <div id="date-edit-${a.id}" style="display:none;margin-bottom:14px;padding:10px;background:var(--navy);border:1px solid var(--navy-border);border-radius:8px">
        <label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px">Date de publication réelle</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" id="date-input-${a.id}" class="input-field" style="max-width:200px" value="${dateInputValue}" />
          <button class="btn-primary small" onclick="saveArticleDate('${a.id}')">✓ Enregistrer</button>
          <button class="btn-secondary small" onclick="clearArticleDate('${a.id}')">Effacer</button>
        </div>
      </div>

      <p style="line-height:1.7">${escHtml(a.summary || 'Aucun résumé généré')}</p>
      ${keyPointsHtml ? `<p style="margin-top:12px;font-weight:600;color:var(--text-primary)">Informations importantes :</p>${keyPointsHtml}` : ''}
    </div>
  `;

  // ── Tableau Défense ──
  let defenseTableHtml = '';
  if (a.domain === 'Défense' && Array.isArray(a.defenseTable) && a.defenseTable.length > 0) {
    const catColors = { 'C4I': '#a78bfa', 'Fonctions': '#4a9eff', "Système d'armes": '#f87171' };
    const rows = a.defenseTable.map(row => {
      const statutColor = row.statut === 'Existant'
        ? 'var(--success)' : row.statut === 'En cours de développement'
        ? 'var(--warning)' : row.statut === 'Concept' ? 'var(--accent)' : 'var(--text-muted)';
      const catColor = catColors[row.categorie] || 'var(--text-muted)';
      return `<tr>
        <td>${escHtml(row.fabricant || 'non précisé')}</td>
        <td>${escHtml(row.produit   || 'non précisé')}</td>
        <td>${escHtml(row.fonctionIA || 'non précisé')}</td>
        <td><span style="color:${statutColor};font-weight:600;font-size:12px">${escHtml(row.statut || 'non précisé')}</span></td>
        <td style="text-align:center">${escHtml(row.anneeSortie || 'non précisé')}</td>
        <td><span style="color:${catColor};font-weight:600;font-size:11px;padding:2px 8px;border-radius:4px;background:${catColor}1a">${escHtml(row.categorie || 'non précisé')}</span></td>
      </tr>`;
    }).join('');

    defenseTableHtml = `
      <div style="margin-top:20px">
        <h4 style="font-family:var(--font-display);font-size:13px;font-weight:700;color:var(--beige);margin-bottom:12px;display:flex;align-items:center;gap:6px">
          🪖 Systèmes & Technologies IA identifiés
        </h4>
        <div style="overflow-x:auto;border-radius:8px;border:1px solid var(--navy-border)">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="background:var(--navy)">
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--navy-border)">Fabricant / Organisation</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--navy-border)">Produit / Technologie</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);border-bottom:1px solid var(--navy-border)">Fonction de l'IA</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--navy-border)">Statut</th>
                <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--navy-border)">Année prévue</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--navy-border)">Catégorie</th>
              </tr>
            </thead>
            <tbody style="color:var(--text-secondary)">
              ${rows}
            </tbody>
          </table>
        </div>
        <button class="btn-secondary small" style="margin-top:10px" onclick="regenerateDefenseTable('${a.id}', this)">🔄 Régénérer ce tableau</button>
      </div>
    `;
  } else if (a.domain === 'Défense' && (!a.defenseTable || a.defenseTable.length === 0)) {
    defenseTableHtml = `
      <div style="margin-top:16px;padding:10px 14px;background:var(--navy);border:1px solid var(--navy-border);border-radius:8px;font-size:12px;color:var(--text-muted);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span>🪖 Aucun système IA spécifique identifié dans cet article</span>
        <button class="btn-secondary small" onclick="regenerateDefenseTable('${a.id}', this)">🔄 Réessayer l'extraction</button>
      </div>
    `;
  }

  const metaSection = `
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="domain-badge ${domainClass(a.domain)}">${a.domain}</span>
      <span class="status-badge ${statusClass(a.status)}">${statusLabel(a.status)}</span>
      <span style="font-size:12px;color:var(--text-muted)">${weekLabel(a)}</span>
      <button class="${a.favorite ? 'btn-warning' : 'btn-secondary'} small" onclick="toggleFavorite('${a.id}');closeModal('article-modal')">${a.favorite ? '⭐ Retirer des favoris' : '☆ Ajouter aux favoris'}</button>
      ${a.status === 'PENDING_REVIEW' ? `<button class="btn-success small" onclick="validateArticle('${a.id}');closeModal('article-modal')">✅ Valider</button>` : ''}
    </div>
  `;

  return summaryBlock + defenseTableHtml + metaSection;
}

// ── Copier le résumé complet (titre, lien, date, résumé, points clés) ──
function copyArticleSummary(id, btnEl) {
  const a = state.articles.find(x => x.id === id);
  if (!a) return;
  const dateLabel = publicationDateLabel(a, false);

  // ── Version texte brut (fallback) ──
  let plainText = `${a.titleFr || a.title}\n`;
  if (a.url) plainText += `🔗 Lire en ligne | ${dateLabel}\n\n`;
  else plainText += `${dateLabel}\n\n`;
  plainText += `${a.summary || ''}\n\n`;
  if (a.keyPoints && a.keyPoints.length > 0) {
    plainText += `Informations importantes :\n`;
    plainText += a.keyPoints.map(p => `• ${p}`).join('\n');
  }

  // ── Version HTML riche : titre en h3, "Informations importantes" en gras, vraie liste à puces ──
  const linkLine = a.url
    ? `<a href="${escHtml(a.url)}">🔗 Lire en ligne</a> | ${escHtml(dateLabel)}`
    : escHtml(dateLabel);
  const pointsHtml = (a.keyPoints && a.keyPoints.length > 0)
    ? `<p><strong>Informations importantes :</strong></p><ul>${a.keyPoints.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>`
    : '';
  const richHtml =
    `<h3>${escHtml(a.titleFr || a.title)}</h3>` +
    `<p>${linkLine}</p>` +
    `<p>${escHtml(a.summary || '')}</p>` +
    pointsHtml;

  // ── Copie avec fallback : HTML riche si supporté, sinon texte brut ──
  if (navigator.clipboard && window.ClipboardItem) {
    const blobHtml  = new Blob([richHtml],  { type: 'text/html'  });
    const blobPlain = new Blob([plainText], { type: 'text/plain' });
    navigator.clipboard.write([
      new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobPlain })
    ]).then(() => {
      showToast('📋 Résumé copié (avec mise en forme)', 'success');
      flashCopyButton(btnEl);
    }).catch(() => {
      // Si l'écriture riche échoue (ex: hors contexte sécurisé), fallback texte brut
      navigator.clipboard.writeText(plainText).then(() => {
        showToast('📋 Résumé copié', 'success');
        flashCopyButton(btnEl);
      }).catch(() => showToast('❌ Impossible de copier', 'error'));
    });
  } else {
    navigator.clipboard.writeText(plainText).then(() => {
      showToast('📋 Résumé copié', 'success');
      flashCopyButton(btnEl);
    }).catch(() => showToast('❌ Impossible de copier', 'error'));
  }
}

function flashCopyButton(btnEl) {
  if (!btnEl) return;
  const original = btnEl.textContent;
  btnEl.textContent = '✓ Copié !';
  setTimeout(() => { btnEl.textContent = original; }, 1500);
}

// ── Édition manuelle de la date de publication ──
function toggleDateEdit(id) {
  const panel = document.getElementById(`date-edit-${id}`);
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function saveArticleDate(id) {
  const article = state.articles.find(a => a.id === id);
  const input = document.getElementById(`date-input-${id}`);
  if (!article || !input) return;

  if (!input.value) {
    showToast('⚠ Choisissez une date ou cliquez sur Effacer', 'warning');
    return;
  }

  const d = new Date(input.value + 'T00:00:00');
  if (isNaN(d.getTime())) {
    showToast('⚠ Date invalide', 'warning');
    return;
  }

  article.publicationDate = d.toISOString();
  article.week     = getWeekNumber(d);
  article.weekYear = getWeekYear(d);
  article.month    = d.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
  article.updatedAt = new Date().toISOString();

  saveToStorage();
  showToast('✅ Date mise à jour', 'success');
  // Rafraîchir la modale et les listes
  openArticleModal(id);
  renderSavedArticles();
  renderValidationQueue();
  renderVeilleIfActive();
}

function clearArticleDate(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  article.publicationDate = null;
  article.updatedAt = new Date().toISOString();
  saveToStorage();
  showToast('❔ Date marquée comme non précisée', 'warning');
  openArticleModal(id);
  renderSavedArticles();
  renderValidationQueue();
  renderVeilleIfActive();
}

// ── Relancer manuellement l'extraction du tableau IA militaire ──
async function regenerateDefenseTable(id, btnEl) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  if (!state.settings.mistralKey) { showToast('⚠ Clé API Mistral requise', 'warning'); return; }

  const originalText = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.textContent = '⏳ Extraction...'; btnEl.disabled = true; }

  try {
    const items = await extractDefenseTable(article);
    article.defenseTable = items;
    article.updatedAt = new Date().toISOString();
    saveToStorage();
    showToast(items.length > 0 ? `✅ ${items.length} système(s) identifié(s)` : 'ℹ Aucun système IA identifié', items.length > 0 ? 'success' : 'info');
    openArticleModal(id); // Rafraîchir la modale
  } catch(e) {
    showToast('❌ Erreur d\'extraction : ' + e.message, 'error');
    if (btnEl) { btnEl.textContent = originalText; btnEl.disabled = false; }
  }
}

// ============ VEILLE ============
function renderVeille() {
  renderVeilleFeatured();
  renderVeilleDomains();
  // Mettre à jour le compteur
  const countEl = document.getElementById('veille-validated-count');
  if (countEl) countEl.textContent = state.articles.filter(a => a.status === 'VALIDATED').length;
}

// Générer les résumés manquants des articles validés dans la veille
async function forceGenerateVeilleSummaries(btnEl) {
  if (!state.settings.mistralKey) {
    showToast('⚠ Clé API Mistral requise dans Paramètres', 'warning');
    return;
  }
  // Articles validés sans résumé
  const missing = state.articles.filter(a =>
    a.status === 'VALIDATED' && (!a.summary || a.summary.trim() === '')
  );
  if (missing.length === 0) {
    showToast('ℹ Tous les articles validés ont déjà un résumé', 'info');
    return;
  }

  const original = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = `⏳ 0 / ${missing.length}...`; }

  let done = 0;
  for (const article of missing) {
    try {
      if (btnEl) btnEl.textContent = `⏳ ${done + 1} / ${missing.length}...`;
      const result = await generateSummaryWithMistral(article);
      article.titleFr      = result.titleFr   || article.title;
      article.title        = article.titleFr;
      article.summary      = result.summary   || '';
      article.keyPoints    = result.keyPoints || [];
      article.defenseTable = result.defenseTable || null;
      if (result.domain) article.domain = result.domain;
      if (result.publicationDate && !article.publicationDate) {
        try {
          const d = new Date(result.publicationDate);
          if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
            article.publicationDate = d.toISOString();
            article.week    = getWeekNumber(d);
            article.weekYear = getWeekYear(d);
          }
        } catch(e) {}
      }
      article.updatedAt = new Date().toISOString();
      done++;
      try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      console.warn('Veille summary error:', article.title, e.message);
      if (e.message.includes('429')) await new Promise(r => setTimeout(r, 5000));
      done++;
    }
  }

  if (btnEl) { btnEl.disabled = false; btnEl.textContent = original; }
  syncAfterChange();
  renderVeille();
  showToast(`✅ ${done} résumé${done > 1 ? 's' : ''} généré${done > 1 ? 's' : ''}`, 'success');
}

function renderVeilleIfActive() {
  if (document.getElementById('tab-veille').classList.contains('active')) {
    renderVeille();
  }
}

function renderVeilleFeatured() {
  const favorites = state.articles.filter(a => a.favorite && a.status === 'VALIDATED');
  const container = document.getElementById('veille-featured');
  if (!container) return;
  if (favorites.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⭐</div><p>Aucun article favori validé</p></div>`;
    return;
  }
  container.innerHTML = favorites.map(a => `
    <div class="article-card">
      <div class="article-card-header">
        <div class="article-card-title" onclick="openArticleModal('${a.id}')">${escHtml(a.titleFr || a.title)}</div>
        <div class="article-card-actions">
          <button class="action-btn favorited" onclick="toggleFavorite('${a.id}')" title="Retirer des favoris">⭐</button>
          <button class="action-btn" onclick="openArticleModal('${a.id}')" title="Voir">👁</button>
          <button class="action-btn" onclick="unvalidateArticle('${a.id}')" title="Remettre en attente" style="color:var(--warning)">↩</button>
          <button class="action-btn" onclick="deleteArticleFromVeille('${a.id}')" title="Supprimer" style="color:var(--danger)">🗑</button>
        </div>
      </div>
      <div class="article-card-meta" style="margin-top:8px">
        <span class="domain-badge ${domainClass(a.domain)}">${DOMAIN_ICONS[a.domain] || ''} ${a.domain}</span>
        <span class="article-date" style="${a.publicationDate ? '' : 'color:var(--warning)'}">${publicationDateLabel(a)}</span>
      </div>
      ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : ''}
    </div>
  `).join('');
}

function renderVeilleDomains() {
  const validated = state.articles.filter(a => a.status === 'VALIDATED'); // CAPITALISED excluded
  const container = document.getElementById('veille-domains');
  if (!container) return;

  const domains = Object.keys(DOMAIN_ICONS);
  const byDomain = {};
  for (const d of domains) {
    byDomain[d] = validated.filter(a => a.domain === d);
  }

  container.innerHTML = domains.map(domain => {
    const articles = byDomain[domain];
    if (articles.length === 0) return '';

    // Group by week+year key to avoid cross-year collisions
    const byWeek = {};
    for (const a of articles) {
      const key = weekKey(a);
      if (!byWeek[key]) byWeek[key] = { label: weekLabel(a), articles: [] };
      byWeek[key].articles.push(a);
    }

    // Sort weeks descending (most recent first)
    const sortedWeeks = Object.entries(byWeek).sort((a, b) => b[0].localeCompare(a[0]));

    const weekHtml = sortedWeeks.map(([key, { label, articles: arts }]) => `
      <div class="week-group">
        <div class="week-label">${label}</div>
        ${arts.map(a => `
          <div class="article-card" style="margin-bottom:8px" id="veille-card-${a.id}">
            <div class="article-card-header">
              <div class="article-card-title" onclick="openArticleModal('${a.id}')">${escHtml(a.titleFr || a.title)}</div>
              <div class="article-card-actions">
                <button class="action-btn ${a.favorite ? 'favorited' : ''}" onclick="toggleFavorite('${a.id}')" title="${a.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${a.favorite ? '⭐' : '☆'}</button>
                <button class="action-btn" onclick="openArticleModal('${a.id}')" title="Voir">👁</button>
                <button class="btn-capitalise" onclick="capitaliseArticle('${a.id}')" title="Marquer comme capitalisé et masquer">✓ Capitalisé</button>
                <button class="action-btn" onclick="unvalidateArticle('${a.id}')" title="Remettre en attente" style="color:var(--warning)">↩</button>
                <button class="action-btn" onclick="deleteArticleFromVeille('${a.id}')" title="Supprimer" style="color:var(--danger)">🗑</button>
              </div>
            </div>
            <div class="article-card-meta">
              ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" style="font-size:11px;color:var(--accent)">🔗 Source</a>` : ''}
              <span class="article-date" style="${a.publicationDate ? '' : 'color:var(--warning)'}">${publicationDateLabel(a)}</span>
            </div>
            ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('');

    return `
      <div class="card domain-section">
        <div class="domain-section-header">
          <div class="domain-section-title">
            <span>${DOMAIN_ICONS[domain]}</span>
            <span>${domain}</span>
          </div>
          <span class="badge">${articles.length}</span>
        </div>
        ${weekHtml}
      </div>
    `;
  }).join('');
}

// ============ ANALYSE ============
function renderAnalyse() {
  renderWorldMap();
  renderWordCloud();
  renderDomainChart();
  renderTopActors();
  renderTrendsChart();
}

function renderWorldMap() {
  const container = document.getElementById('world-map');
  const legend = document.getElementById('country-legend');
  if (!container) return;

  const countryCount = {};
  const countryKeywords = {
    'France': ['france', 'français', 'paris', 'mistral', 'thales', 'airbus', 'gouvernement français'],
    'États-Unis': ['usa', 'united states', 'american', 'openai', 'google', 'microsoft', 'meta', 'nvidia'],
    'Chine': ['chine', 'chinese', 'baidu', 'alibaba', 'huawei', 'beijing'],
    'Royaume-Uni': ['uk', 'britain', 'british', 'london', 'deepmind'],
    'Allemagne': ['germany', 'german', 'deutsch', 'berlin'],
    'Israël': ['israel', 'israeli', 'tel aviv'],
    'Russie': ['russia', 'russian', 'moscou'],
    'Japon': ['japan', 'japanese', 'tokyo', 'sony']
  };

  const allText = state.articles.filter(a => a.status === 'VALIDATED')
    .map(a => (a.content + ' ' + a.title).toLowerCase()).join(' ');

  for (const [country, keywords] of Object.entries(countryKeywords)) {
    const count = keywords.filter(k => allText.includes(k)).length;
    if (count > 0) countryCount[country] = count * 2;
  }

  const colors = ['#4a9eff', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#f472b6', '#fb923c', '#22d3ee'];
  const countries = Object.entries(countryCount).sort((a,b) => b[1]-a[1]);

  if (countries.length === 0) {
    container.innerHTML = `<div class="map-placeholder"><div style="font-size:32px;margin-bottom:8px">🌍</div><p>Importez des articles pour voir la carte des acteurs</p></div>`;
    if (legend) legend.innerHTML = '';
    return;
  }

  // Simple SVG world representation
  container.innerHTML = `
    <div style="padding:16px;text-align:center;width:100%">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.6px">Présence géographique détectée</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
        ${countries.map(([country, count], i) => `
          <div style="background:${colors[i % colors.length]}20;border:1px solid ${colors[i % colors.length]}40;border-radius:8px;padding:10px 14px;text-align:center;min-width:80px">
            <div style="font-size:22px;margin-bottom:4px">${countryFlag(country)}</div>
            <div style="font-size:12px;color:var(--text-primary);font-weight:600">${country}</div>
            <div style="font-size:11px;color:var(--text-muted)">${count} mentions</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if (legend) {
    legend.innerHTML = countries.slice(0, 5).map(([country, count], i) => `
      <div class="country-item">
        <div class="country-dot" style="background:${colors[i % colors.length]}"></div>
        <span>${country} (${count})</span>
      </div>
    `).join('');
  }
}

function countryFlag(name) {
  const flags = { 'France': '🇫🇷', 'États-Unis': '🇺🇸', 'Chine': '🇨🇳', 'Royaume-Uni': '🇬🇧', 'Allemagne': '🇩🇪', 'Israël': '🇮🇱', 'Russie': '🇷🇺', 'Japon': '🇯🇵' };
  return flags[name] || '🌐';
}

function renderWordCloud() {
  const container = document.getElementById('word-cloud');
  if (!container) return;

  const allText = state.articles.filter(a => a.status === 'VALIDATED')
    .map(a => a.content + ' ' + a.title + ' ' + a.summary).join(' ');

  if (!allText.trim()) {
    container.innerHTML = `<div class="empty-state" style="width:100%;padding:24px"><div class="empty-icon">☁</div><p>Pas encore de données</p></div>`;
    return;
  }

  const stopWords = new Set(['les','des','une','que','qui','dans','est','sur','par','pour','avec','plus','cette','tout','mais','comme','son','ses','leur','leurs','nous','vous','ils','elles','ont','été','être','avoir','faire','aussi','très','bien','peut','même','sans','sous','entre','après','avant','où','dont','ce','se','si','au','aux','un','de','la','le','et','en','du','il','elle','je','tu','on','ne','pas','plus','que','quand','car','cela','ceci','ainsi','donc','or','ni','soit','alors','lors','dès','dès','lors','lors']);

  const words = allText.toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûüç\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !stopWords.has(w));

  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);

  const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 40);
  const max = sorted[0]?.[1] || 1;

  const colors = ['var(--accent)', 'var(--success)', 'var(--gold)', '#a78bfa', '#f472b6', '#fb923c'];
  container.innerHTML = sorted.map(([word, count]) => {
    const size = 10 + Math.round((count / max) * 18);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const bg = color.replace('var(', '').replace(')', '');
    return `<span class="word-item" style="font-size:${size}px;color:${color};background:${color}15;font-weight:${count > max * 0.5 ? '700' : '400'}">${escHtml(word)}</span>`;
  }).join('');
}

function renderDomainChart() {
  const canvas = document.getElementById('domain-canvas');
  const legendEl = document.getElementById('domain-legend');
  if (!canvas) return;

  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  const domains = Object.keys(DOMAIN_ICONS);
  const counts = domains.map(d => validated.filter(a => a.domain === d).length);
  const total = counts.reduce((s, c) => s + c, 0);

  if (total === 0) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (legendEl) legendEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Aucun article validé</div>';
    return;
  }

  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = 100, innerR = 55;
  let angle = -Math.PI / 2;
  const colors = Object.values(DOMAIN_COLORS);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  domains.forEach((domain, i) => {
    if (counts[i] === 0) return;
    const slice = (counts[i] / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--navy-mid').trim() || '#162032';
    ctx.fill();
    angle += slice;
  });

  // Center text
  ctx.fillStyle = '#e8e4dc';
  ctx.font = 'bold 22px Syne, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 6);
  ctx.font = '11px DM Sans, sans-serif';
  ctx.fillStyle = '#5a6a7a';
  ctx.fillText('articles', cx, cy + 12);

  if (legendEl) {
    legendEl.innerHTML = domains.filter((_, i) => counts[i] > 0).map((domain, i) => {
      const origIdx = domains.indexOf(domain);
      return `<div class="legend-item"><div class="legend-dot" style="background:${colors[origIdx]}"></div><span>${domain} (${counts[origIdx]})</span></div>`;
    }).join('');
  }
}

function renderTopActors() {
  const container = document.getElementById('top-actors');
  if (!container) return;

  const allText = state.articles.filter(a => a.status === 'VALIDATED')
    .map(a => (a.content || '') + ' ' + (a.title || '')).join(' ');

  const actors = [
    'OpenAI', 'Anthropic', 'Google', 'Microsoft', 'Meta', 'Mistral', 'Nvidia',
    'Thales', 'Airbus', 'Dassault', 'Amazon', 'Apple', 'DeepMind', 'Hugging Face',
    'Palantir', 'Scale AI', 'Cohere', 'Stability AI', 'Midjourney'
  ];

  const found = actors
    .map(a => ({ name: a, count: (allText.match(new RegExp(a, 'gi')) || []).length }))
    .filter(a => a.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  if (found.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:24px"><div class="empty-icon">🏆</div><p>Pas encore de données</p></div>`;
    return;
  }

  const max = found[0].count;
  container.innerHTML = found.map((a, i) => `
    <div class="actor-row">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--text-muted);font-weight:700;min-width:14px">${i + 1}</span>
        <span class="actor-name">${escHtml(a.name)}</span>
      </div>
      <div class="actor-count">
        <div class="actor-bar" style="width:${Math.round((a.count / max) * 60)}px"></div>
        <span>${a.count}</span>
      </div>
    </div>
  `).join('');
}

function renderTrendsChart() {
  const canvas = document.getElementById('trends-chart');
  if (!canvas) return;

  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  if (validated.length === 0) return;

  const byMonth = {};
  for (const a of validated) {
    const key = new Date(a.date).toLocaleString('fr-FR', { month: 'short', year: '2-digit' });
    byMonth[key] = (byMonth[key] || 0) + 1;
  }

  const labels = Object.keys(byMonth).slice(-8);
  const values = labels.map(l => byMonth[l]);
  if (labels.length === 0) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.parentElement.offsetWidth - 32 || 600;
  const H = 180;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  const pad = { t: 20, r: 20, b: 40, l: 36 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const maxV = Math.max(...values, 1);
  const step = plotW / (labels.length - 1 || 1);

  // Grid
  ctx.strokeStyle = 'rgba(36,52,71,0.8)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#5a6a7a';
    ctx.font = '10px DM Sans, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV * (1 - i / 4)), pad.l - 6, y + 3);
  }

  // Area fill
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t + plotH);
  labels.forEach((_, i) => {
    const x = pad.l + i * step;
    const y = pad.t + plotH - (values[i] / maxV) * plotH;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.l + (labels.length - 1) * step, pad.t + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  grad.addColorStop(0, 'rgba(74,158,255,0.3)');
  grad.addColorStop(1, 'rgba(74,158,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  labels.forEach((_, i) => {
    const x = pad.l + i * step;
    const y = pad.t + plotH - (values[i] / maxV) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Points & labels
  labels.forEach((label, i) => {
    const x = pad.l + i * step;
    const y = pad.t + plotH - (values[i] / maxV) * plotH;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#4a9eff';
    ctx.fill();
    ctx.fillStyle = '#9ba8b5';
    ctx.font = '10px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, H - 10);
  });
}

// ============ CHAT / RAG ============
function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

function askSuggestion(btn) {
  document.getElementById('chat-input').value = btn.textContent;
  sendChatMessage();
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';

  const messagesEl = document.getElementById('chat-messages');

  // Remove welcome screen
  const welcome = messagesEl.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // Add user message
  messagesEl.innerHTML += createMessageHTML('user', question);

  // Add typing indicator
  const typingId = 'typing-' + Date.now();
  messagesEl.innerHTML += `<div class="message assistant" id="${typingId}">
    <div class="message-avatar">🧠</div>
    <div class="message-bubble"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>
  </div>`;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const context = buildRAGContext(question);
    const answer = await callChatAPI(question, context);

    document.getElementById(typingId)?.remove();
    messagesEl.innerHTML += createMessageHTML('assistant', answer);
  } catch(err) {
    document.getElementById(typingId)?.remove();
    messagesEl.innerHTML += createMessageHTML('assistant', '❌ Erreur lors de la génération : ' + err.message);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
  state.chatHistory.push({ role: 'user', content: question });
}

function buildRAGContext(question) {
  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  if (validated.length === 0) return 'Aucun article validé dans la base de connaissance.';

  // Simple keyword matching for RAG
  const q = question.toLowerCase();
  const relevant = validated
    .map(a => ({ article: a, score: relevanceScore(q, a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ article: a }) => `
Titre: ${a.titleFr || a.title}
Domaine: ${a.domain}
Date: ${formatDate(a.date)}
Résumé: ${a.summary || 'N/A'}
Points clés: ${(a.keyPoints || []).join(' | ')}
`.trim());

  return `BASE DE CONNAISSANCE (${validated.length} articles au total):\n\n${relevant.join('\n\n---\n\n')}`;
}

function relevanceScore(query, article) {
  const text = ((article.titleFr || article.title) + ' ' + article.summary + ' ' + article.content + ' ' + article.domain).toLowerCase();
  const words = query.split(' ').filter(w => w.length > 3);
  return words.filter(w => text.includes(w)).length;
}

async function callChatAPI(question, context) {
  if (!state.settings.mistralKey) {
    return generateLocalRAGAnswer(question, context);
  }

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.settings.mistralKey}`
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `Tu es un assistant expert en veille stratégique IA. Tu réponds en français, de façon concise et structurée, en te basant uniquement sur les articles fournis en contexte. Si la réponse n'est pas dans les articles, dis-le clairement. Utilise des listes à puces pour la clarté.`
          },
          {
            role: 'user',
            content: `Contexte :\n${context}\n\nQuestion : ${question}`
          }
        ]
      })
    });

    if (!response.ok) throw new Error('API ' + response.status);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Aucune réponse générée.';
  } catch(e) {
    return generateLocalRAGAnswer(question, context);
  }
}

function generateLocalRAGAnswer(question, context) {
  const articles = state.articles.filter(a => a.status === 'VALIDATED');
  const q = question.toLowerCase();

  if (articles.length === 0) {
    return '📭 Votre base de connaissance est vide. Importez et validez des articles pour pouvoir les interroger.';
  }

  // Simple keyword-based answers
  let answer = `**Analyse de votre veille** (${articles.length} articles validés)\n\n`;

  const domainCounts = {};
  articles.forEach(a => { domainCounts[a.domain] = (domainCounts[a.domain] || 0) + 1; });
  const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];

  if (q.includes('tendance') || q.includes('résume') || q.includes('mois')) {
    answer += `**Tendances principales :**\n`;
    Object.entries(domainCounts).forEach(([d, c]) => answer += `• ${DOMAIN_ICONS[d]} ${d} : ${c} article(s)\n`);
    if (topDomain) answer += `\n📌 Domaine le plus actif : **${topDomain[0]}** avec ${topDomain[1]} articles.`;
  } else if (q.includes('défense') || q.includes('militaire')) {
    const defense = articles.filter(a => a.domain === 'Défense');
    answer += defense.length > 0
      ? `**${defense.length} article(s) Défense :**\n` + defense.map(a => `• ${a.titleFr || a.title}`).join('\n')
      : 'Aucun article Défense validé.';
  } else if (q.includes('acteur') || q.includes('entreprise') || q.includes('domine')) {
    answer += `**Acteurs identifiés dans la veille :**\n`;
    const allText = articles.map(a => a.content || a.title).join(' ');
    ['OpenAI','Google','Microsoft','Meta','Mistral','Thales','Anthropic'].forEach(a => {
      if (allText.toLowerCase().includes(a.toLowerCase())) answer += `• ${a}\n`;
    });
  } else {
    const relevant = articles.filter(a =>
      question.split(' ').some(w => w.length > 3 && (a.title + ' ' + a.summary).toLowerCase().includes(w.toLowerCase()))
    ).slice(0, 3);
    if (relevant.length > 0) {
      answer += `**Articles pertinents trouvés :**\n`;
      relevant.forEach(a => answer += `• **${a.titleFr || a.title}** — ${a.summary || ''}\n`);
    } else {
      answer += `Je n'ai pas trouvé d'articles directement liés à votre question dans la base de ${articles.length} articles.\n\nEssayez : "Tendances IA", "Acteurs défense", ou "Résume la semaine".`;
    }
  }

  return answer;
}

function createMessageHTML(role, content) {
  const avatar = role === 'user' ? '👤' : '🧠';
  const formatted = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>').replace(/• /g, '• ');
  return `
    <div class="message ${role}">
      <div class="message-avatar">${avatar}</div>
      <div class="message-bubble">${formatted}</div>
    </div>
  `;
}

// ============ EXPORT ============
// ── Sélecteur de semaines pour Confluence (même logique que newsletter) ──
function renderConfluenceWeekSelector() {
  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  const wMap = {};
  for (const a of validated) {
    const key = weekKey(a);
    if (!wMap[key]) wMap[key] = { label: weekLabel(a), count: 0 };
    wMap[key].count++;
  }
  const weeks = Object.entries(wMap).sort((a, b) => b[0].localeCompare(a[0]));
  const container = document.getElementById('confluence-weeks-container');
  if (!container) return;
  if (weeks.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px">Aucun article validé</div>`;
    return;
  }
  container.innerHTML = weeks.map(([key, { label, count }]) => `
    <label class="checkbox-item">
      <input type="checkbox" value="${key}" class="confluence-week-cb" ${count > 0 ? 'checked' : ''}>
      ${label} <span style="color:var(--text-muted);font-size:11px">(${count} article${count > 1 ? 's' : ''})</span>
    </label>
  `).join('');
}

function exportConfluence() {
  const selectedKeys  = [...document.querySelectorAll('.confluence-week-cb:checked')].map(i => i.value);
  const selectedDomains = [...document.querySelectorAll('#export-domains input:checked')].map(i => i.value);

  if (selectedKeys.length === 0) {
    showToast('⚠ Sélectionnez au moins une semaine', 'warning');
    return;
  }

  let articles = state.articles.filter(a =>
    a.status === 'VALIDATED' &&
    selectedDomains.includes(a.domain) &&
    selectedKeys.includes(weekKey(a))
  );

  if (articles.length === 0) {
    showToast('⚠ Aucun article pour la sélection', 'warning');
    return;
  }

  // Même format que les résumés dans l'onglet Veille :
  // ### Titre (h3), lien | date, résumé, **Informations importantes :**, • points
  let output = `Veille Stratégique IA\n`;
  output += `Généré le ${new Date().toLocaleDateString('fr-FR')}\n`;
  output += '═'.repeat(60) + '\n\n';

  const featured = articles.filter(a => a.favorite);
  if (featured.length > 0) {
    output += `⭐ Articles à la une\n\n`;
    featured.forEach(a => { output += formatArticleConfluence(a); });
    output += '─'.repeat(60) + '\n\n';
  }

  const domains = Object.keys(DOMAIN_ICONS);
  const sortedKeys = [...selectedKeys].sort((a, b) => a.localeCompare(b));

  for (const domain of domains) {
    const domainArts = articles.filter(a => a.domain === domain);
    if (domainArts.length === 0) continue;

    output += `${DOMAIN_ICONS[domain]} ${domain}\n`;
    output += '─'.repeat(40) + '\n\n';

    for (const key of sortedKeys) {
      const arts = domainArts.filter(a => weekKey(a) === key);
      if (arts.length === 0) continue;
      output += `${weekMap_label(key)} :\n\n`;
      arts.forEach(a => { output += formatArticleConfluence(a); });
    }
  }

  showExportPreview(output);
}

// Format résumé complet style Veille : ### Titre, lien | date, résumé, **Informations importantes :**, • points
function formatArticleConfluence(a) {
  const dateLabel = publicationDateLabel(a, false);
  const linkLine  = a.url ? `🔗 Lire en ligne | ${dateLabel}` : dateLabel;
  const points    = (a.keyPoints || []).map(p => `• ${p}`).join('\n');

  let block = '';
  block += `### ${a.titleFr || a.title}\n`;
  block += `${linkLine}\n\n`;
  block += `${a.summary || ''}\n\n`;
  if (points) {
    block += `**Informations importantes :**\n${points}\n`;
  }
  block += '\n';
  return block;
}

function renderNewsletterWeekSelector() {
  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  const weekMap = {};
  for (const a of validated) {
    const key = weekKey(a);
    if (!weekMap[key]) weekMap[key] = { label: weekLabel(a), count: 0 };
    weekMap[key].count++;
  }
  const weeks = Object.entries(weekMap).sort((a, b) => b[0].localeCompare(a[0]));
  const container = document.getElementById('newsletter-weeks-container');
  if (!container) return;
  if (weeks.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px">Aucun article validé</div>`;
    return;
  }
  container.innerHTML = weeks.map(([key, { label, count }]) => `
    <label class="checkbox-item">
      <input type="checkbox" value="${key}" checked class="newsletter-week-cb">
      ${label} <span style="color:var(--text-muted);font-size:11px">(${count} article${count > 1 ? 's' : ''})</span>
    </label>
  `).join('');
}

function exportNewsletter() {
  const selectedKeys = [...document.querySelectorAll('.newsletter-week-cb:checked')].map(i => i.value);
  if (selectedKeys.length === 0) { showToast('⚠ Sélectionnez au moins une semaine', 'warning'); return; }

  const validated = state.articles.filter(a => a.status === 'VALIDATED' && selectedKeys.includes(weekKey(a)));
  if (validated.length === 0) { showToast('⚠ Aucun article validé pour les semaines sélectionnées', 'warning'); return; }

  const titleVal = document.getElementById('newsletter-title').value.trim();
  const title = titleVal || `Veille IA`;
  let output = `${title}\n${'═'.repeat(Math.min(title.length, 60))}\n\n`;

  // Sort selected keys chronologically (oldest first for display)
  const sortedKeys = [...selectedKeys].sort((a, b) => a.localeCompare(b));

  // ── Articles à la une ──
  const featured = validated.filter(a => a.favorite);
  if (featured.length > 0) {
    output += `Articles à la une :\n`;
    for (const key of sortedKeys) {
      const arts = featured.filter(a => weekKey(a) === key);
      if (arts.length === 0) continue;
      output += `    - ${weekMap_label(key)}\n`;
      arts.forEach(a => { output += `        - ${a.titleFr || a.title}\n`; });
    }
    output += '\n';
  }

  // ── Veille extérieure par domaine ──
  output += `Veille extérieure :\n`;
  const domains = Object.keys(DOMAIN_ICONS);

  for (const domain of domains) {
    const domainArts = validated.filter(a => a.domain === domain);
    if (domainArts.length === 0) continue;

    output += `    - ${DOMAIN_ICONS[domain]} ${domain} :\n`;

    for (const key of sortedKeys) {
      const arts = domainArts.filter(a => weekKey(a) === key);
      if (arts.length === 0) continue;
      output += `        - ${weekMap_label(key)}\n`;
      arts.forEach(a => { output += `            - ${a.titleFr || a.title}\n`; });
    }
  }

  showExportPreview(output);
}

// Helper: get week label from key (e.g. "S17-2026" → "Semaine 17 — 2026")
function weekMap_label(key) {
  const m = key.match(/S(\d+)-(\d+)/);
  if (m) return `Semaine ${parseInt(m[1])} — ${m[2]}`;
  return key;
}

// Format a single article in the exact requested style
function formatArticleNewsletter(a) {
  const dateStr = publicationDateLabel(a, false);
  const link = a.url ? `🔗 Lire en ligne` : '';
  const linkPart = a.url ? `[🔗 Lire en ligne](${a.url})` : '';
  const points = (a.keyPoints || []).map(p => `• ${p}`).join('\n');

  let block = '';
  block += `${a.titleFr || a.title}\n`;
  block += `${linkPart}${linkPart && dateStr ? ' | ' : ''}${dateStr}\n`;
  block += `\n`;
  block += `${a.summary || ''}\n`;
  block += `\n`;
  if (points) {
    block += `Informations importantes :\n`;
    block += `${points}\n`;
  }
  block += `\n`;
  return block;
}

// Format merged articles (same topic, multiple sources)
function formatArticleNewsletterMerged(articles) {
  const main = articles[0];

  // Combine all unique key points
  const allPoints = [];
  articles.forEach(a => (a.keyPoints || []).forEach(p => { if (!allPoints.includes(p)) allPoints.push(p); }));
  const points = allPoints.slice(0, 10).map(p => `• ${p}`).join('\n');

  let block = '';
  block += `${main.titleFr || main.title}\n`;
  // Multiple links listed
  articles.forEach(a => { if (a.url) block += `[🔗 Lire en ligne](${a.url}) | ${publicationDateLabel(a, false)}\n`; });
  block += `\n`;
  block += `${main.summary || ''}\n`;
  block += `\n`;
  if (points) {
    block += `Informations importantes :\n`;
    block += `${points}\n`;
  }
  block += `\n`;
  return block;
}

// "26 avr. 2026" format
function formatDateShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch(e) { return iso; }
}

// Group articles with similar topics for newsletter merge
function groupSimilarArticles(articles) {
  const groups = [];
  const used = new Set();
  const MERGE_THRESHOLD = 0.35; // lower threshold for newsletter topic grouping

  for (let i = 0; i < articles.length; i++) {
    if (used.has(i)) continue;
    const group = [articles[i]];
    used.add(i);

    for (let j = i + 1; j < articles.length; j++) {
      if (used.has(j)) continue;
      if (articles[i].domain !== articles[j].domain) continue;
      const sim = jaccardSimilarity(
        normalizeText(articles[i].titleFr + ' ' + articles[i].summary),
        normalizeText(articles[j].titleFr + ' ' + articles[j].summary)
      );
      if (sim >= MERGE_THRESHOLD) {
        group.push(articles[j]);
        used.add(j);
      }
    }

    // Build a merged title for the group
    const mergedTitle = group.length > 1
      ? group[0].titleFr + ` (+ ${group.length - 1} article${group.length > 2 ? 's' : ''} similaire${group.length > 2 ? 's' : ''})`
      : group[0].titleFr;

    groups.push({ articles: group, mergedTitle });
  }
  return groups;
}

function formatArticleMarkdown(a) {
  const points = (a.keyPoints || []).map(p => `- ${p}`).join('\n');
  const dateLabel = a.publicationDate ? formatDate(a.publicationDate) : formatDate(a.date);
  return `### ${a.titleFr || a.title}\n\n${a.url ? `[Lire en ligne](${a.url})` : ''} | ${dateLabel}\n\n${a.summary || ''}\n\n**Informations importantes :**\n${points}\n\n**Domaine :** ${a.domain}\n\n---\n\n`;
}

function showExportPreview(content) {
  const preview = document.getElementById('export-preview');
  const copyBtn = document.getElementById('copy-btn');
  // Store raw for copy
  preview.dataset.raw = content;
  // Render with basic formatting for readability
  preview.innerHTML = content
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[🔗 Lire en ligne\]\((https?:\/\/[^\)]+)\)/g,
      '<a href="$1" target="_blank" style="color:var(--accent)">🔗 Lire en ligne</a>')
    .replace(/^(⭐.*|🛡.*|🏛.*|🏢.*|💻.*|🤖.*|🦾.*|⚖.*)$/gm,
      '<strong style="color:var(--beige);font-size:14px">$1</strong>')
    .replace(/^(Semaine \d+ — \d+) :$/gm,
      '<span style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.8px">$1</span>')
    .replace(/^(─+)$/gm, '<hr style="border-color:var(--navy-border);margin:8px 0">')
    .replace(/\n/g, '<br>');

  if (copyBtn) { copyBtn.style.display = ''; }
  showToast('✅ Export généré — prêt à copier', 'success');
}

function copyExport() {
  const preview = document.getElementById('export-preview');
  const content = preview.dataset.raw || preview.textContent;
  navigator.clipboard.writeText(content).then(() => showToast('📋 Copié dans le presse-papier', 'success'));
}

// ============ SETTINGS ============
function saveMistralSettings() {
  state.settings.mistralKey = document.getElementById('mistral-key').value.trim();
  saveToStorage();
  updateConnectionStatus();
  showToast('✅ Clé API Mistral sauvegardée', 'success');
}

async function testMistralConnection() {
  const key = document.getElementById('mistral-key').value.trim();
  if (!key) { showToast('⚠ Entrez votre clé API Mistral', 'warning'); return; }
  showLoading('Test de connexion Mistral...');
  const statusEl = document.getElementById('mistral-status');
  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [{ role: 'user', content: 'Réponds juste "OK"' }],
        max_tokens: 5
      })
    });
    hideLoading();
    if (response.ok) {
      statusEl.textContent = '✅ Connexion réussie — Mistral API opérationnelle';
      statusEl.className = 'connection-status success';
      document.querySelector('.status-dot')?.classList.add('active');
      document.querySelector('.sidebar-footer span').textContent = 'Mistral connecté';
    } else {
      const err = await response.json().catch(() => ({}));
      statusEl.textContent = '❌ Erreur ' + response.status + ' — ' + (err.message || 'Clé invalide');
      statusEl.className = 'connection-status error';
    }
  } catch(e) {
    hideLoading();
    statusEl.textContent = '❌ Impossible de joindre api.mistral.ai';
    statusEl.className = 'connection-status error';
  }
}

function updateConnectionStatus() {
  const dot = document.querySelector('.status-dot');
  const label = document.querySelector('.sidebar-footer span');
  if (state.settings.mistralKey) {
    dot?.classList.add('active');
    if (label) label.textContent = 'Mistral connecté';
  } else {
    dot?.classList.remove('active');
    if (label) label.textContent = 'Mistral non configuré';
  }
}

function saveInoreaderSettings() {
  state.settings.inoreaderAppId = document.getElementById('inoreader-app-id').value.trim();
  state.settings.inoreaderAppKey = document.getElementById('inoreader-app-key').value.trim();
  state.settings.inoreaderToken = document.getElementById('inoreader-access-token').value.trim();
  saveToStorage();
  showToast('✅ Inoreader sauvegardé', 'success');
}

function updateThreshold(val) {
  state.settings.duplicateThreshold = parseInt(val);
  document.getElementById('threshold-value').textContent = val + '%';
}

function saveDuplicateSettings() {
  const radio = document.querySelector('input[name="sensitivity"]:checked');
  state.settings.sensitivity = radio?.value || 'normal';
  saveToStorage();
  showToast('✅ Paramètres de doublons sauvegardés', 'success');
}

function renderSettings() {
  const total = state.articles.filter(a => a.status !== 'REJECTED').length;
  const favs = state.articles.filter(a => a.favorite).length;
  const pending = state.articles.filter(a => a.status === 'PENDING_REVIEW' || a.status === 'NEW').length;
  document.getElementById('settings-total').textContent = total;
  document.getElementById('settings-favorites').textContent = favs;
  document.getElementById('settings-pending').textContent = pending;

  // Restore saved values
  const keyEl = document.getElementById('mistral-key');
  if (keyEl && state.settings.mistralKey) keyEl.value = state.settings.mistralKey;

  const threshEl = document.getElementById('duplicate-threshold');
  if (threshEl) {
    threshEl.value = state.settings.duplicateThreshold;
    document.getElementById('threshold-value').textContent = state.settings.duplicateThreshold + '%';
  }

  const radio = document.querySelector(`input[name="sensitivity"][value="${state.settings.sensitivity}"]`);
  if (radio) radio.checked = true;

  updateConnectionStatus();
}

function exportData() {
  const data = JSON.stringify(state, null, 2);
  downloadFile(data, 'ia-platform-backup.json', 'application/json');
}

function importData() { document.getElementById('import-file').click(); }

function loadData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      state = { ...state, ...data };
      saveToStorage();
      renderAllViews();
      showToast('✅ Données importées', 'success');
    } catch(err) {
      showToast('❌ Fichier invalide', 'error');
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('⚠ Vider toutes les données ? Cette action est irréversible.')) return;
  state.articles = [];
  state.chatHistory = [];
  saveToStorage();
  renderAllViews();
  showToast('🗑 Données effacées', 'warning');
}

// ============ INOREADER ============
// ============ ANALYSE TEXTE COLLÉ ============
async function analysepastedText() {
  const text = document.getElementById('paste-text-input').value.trim();
  if (!text) { showToast('⚠ Collez du texte avant d\'analyser', 'warning'); return; }
  if (!state.settings.mistralKey) { showToast('⚠ Clé API Mistral requise dans Paramètres', 'warning'); return; }

  const resultEl = document.getElementById('paste-analysis-result');
  resultEl.style.display = 'none';

  // 1. Extraire tous les URLs du texte
  const urlRegex = /https?:\/\/[^\s\)\]\}"'<>]+/g;
  const foundUrls = [...new Set(text.match(urlRegex) || [])];

  if (foundUrls.length === 0) {
    showToast('⚠ Aucun lien URL trouvé dans le texte', 'warning');
    return;
  }

  showLoading(`Analyse du texte — ${foundUrls.length} lien(s) détecté(s)...`);

  // 2. Demander à Mistral quels liens sont liés à l'IA
  let aiUrls = [];
  try {
    const filterResp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.mistralKey}` },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `Tu es un expert en veille IA. On te donne un texte avec des liens et descriptions.
Tu dois identifier uniquement les liens dont le sujet traite d'intelligence artificielle, machine learning, LLM, robotique, automatisation IA, ou technologies IA.
RÉPONDS UNIQUEMENT avec un JSON valide : { "ai_urls": ["url1", "url2"] }
Si aucun lien ne traite d'IA, réponds : { "ai_urls": [] }`
          },
          { role: 'user', content: `Texte à analyser :\n\n${text}\n\nLiens détectés :\n${foundUrls.join('\n')}` }
        ]
      })
    });
    const filterData = await filterResp.json();
    const filterText = filterData.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(filterText.replace(/```json|```/g, '').trim());
    aiUrls = parsed.ai_urls || [];
  } catch(e) {
    // Fallback : filtrer localement par mots-clés si Mistral échoue
    aiUrls = foundUrls.filter(url => isAiRelated(url + ' ' + text));
  }

  if (aiUrls.length === 0) {
    hideLoading();
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="import-info" style="background:var(--warning-bg);border-color:rgba(251,191,36,0.3)">
      <span>⚠</span><span>Aucun lien lié à l'IA détecté parmi les ${foundUrls.length} URL(s) trouvé(s).</span>
    </div>`;
    return;
  }

  showLoading(`${aiUrls.length} lien(s) IA détecté(s) — génération des résumés...`);

  // 3. Générer un résumé pour chaque URL IA
  // ⚠️ On accumule les articles dans un tableau temporaire et on sauvegarde UNE SEULE FOIS à la fin
  // pour éviter que syncAfterChange écrase le state pendant la boucle
  const newArticles = [];
  let done = 0;

  for (const url of aiUrls) {
    showLoading(`Résumé ${done + 1} / ${aiUrls.length} : ${url.substring(0, 60)}...`);
    try {
      // Vérifier doublon URL uniquement dans les articles déjà en base + ceux déjà ajoutés dans cette session
      if (url) {
        const normalizedNew = normalizeUrl(url);
        const alreadyExists = state.articles.some(a => a.url && normalizeUrl(a.url) === normalizedNew)
          || newArticles.some(a => a.url && normalizeUrl(a.url) === normalizedNew);
        if (alreadyExists) {
          console.log('[PASTE] URL déjà importée, ignorée :', url.substring(0, 60));
          done++;
          continue;
        }
      }

      // Récupérer contenu de la page
      let pageText = '', pageTitle = '', extractedPubDate = null;
      try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          const data = await resp.json();
          const html = data.contents || '';
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

          const dateCandidates = [
            html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
            html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)?.[1],
            html.match(/content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i)?.[1],
            html.match(/<time[^>]*datetime=["']([^"']+)["']/i)?.[1],
          ].filter(Boolean);
          for (const c of dateCandidates) {
            try {
              const d = new Date(c);
              if (!isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() <= new Date().getFullYear() + 1) {
                extractedPubDate = d.toISOString(); break;
              }
            } catch(e) {}
          }

          pageText = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{3,}/g, ' ').trim().substring(0, 4000);
        }
      } catch(e) {}

      const now = new Date();
      const refDate = extractedPubDate ? new Date(extractedPubDate) : now;
      const articleData = {
        id: generateId(), url,
        title: pageTitle || url, titleFr: '',
        content: pageText, domain: '', status: 'PENDING_REVIEW',
        date: now.toISOString(),
        publicationDate: extractedPubDate,
        week: getWeekNumber(refDate), weekYear: getWeekYear(refDate),
        month: refDate.toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
        favorite: false, summary: '', keyPoints: [],
        fromPaste: true, updatedAt: now.toISOString()
      };

      // Générer résumé Mistral
      const result = await generateSummaryWithMistral(articleData);
      articleData.titleFr   = result.titleFr   || pageTitle || url;
      articleData.title     = articleData.titleFr;
      articleData.summary   = result.summary   || '';
      articleData.keyPoints = result.keyPoints || [];
      articleData.defenseTable = result.defenseTable || null;
      if (result.domain) articleData.domain = result.domain;
      if (!articleData.domain) articleData.domain = detectDomain(articleData.titleFr + ' ' + articleData.summary);
      if (!articleData.publicationDate && result.publicationDate) {
        try {
          const d = new Date(result.publicationDate);
          if (!isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() <= new Date().getFullYear() + 1) {
            articleData.publicationDate = d.toISOString();
            articleData.week    = getWeekNumber(d);
            articleData.weekYear = getWeekYear(d);
          }
        } catch(e) {}
      }

      newArticles.push(articleData);
      done++;
      await new Promise(r => setTimeout(r, 800));

    } catch(e) {
      console.warn('Paste article error:', url, e.message);
      done++;
    }
  }

  // Vérifier les doublons de contenu uniquement contre les articles DÉJÀ dans state
  // (pas contre les autres nouveaux articles de cette session pour éviter les faux positifs)
  for (const articleData of newArticles) {
    // findDuplicate cherche dans state.articles — les nouveaux n'y sont pas encore, pas de risque
    const dup = findDuplicate(articleData);
    if (dup) {
      articleData.status = 'DUPLICATE_SUSPECTED';
      // On garde seulement le dernier doublon détecté pour la modale
      state.currentDuplicateCheck = { new: articleData, existing: dup.article, score: dup.score };
    }
    // statut PENDING_REVIEW par défaut déjà assigné lors de la création
    state.articles.push(articleData);
  }

  // UNE SEULE sauvegarde à la fin, SANS déclencher la sync immédiate
  try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}
  // Sync différée (la sync auto normale prendra le relai)
  syncAfterChange();

  hideLoading();

  const added = newArticles.length;

  // Afficher résultat
  resultEl.style.display = 'block';
  resultEl.innerHTML = added > 0
    ? `<div class="import-info" style="background:var(--success-bg);border-color:rgba(52,211,153,0.3)">
        <span>✅</span>
        <span><strong>${added} article${added > 1 ? 's' : ''} IA ajouté${added > 1 ? 's' : ''}</strong> sur ${foundUrls.length} lien(s) détecté(s). <button class="btn-primary small" onclick="switchTab('validation')" style="margin-left:8px">→ Voir la file de validation</button></span>
      </div>`
    : `<div class="import-info" style="background:var(--warning-bg);border-color:rgba(251,191,36,0.3)">
        <span>⚠</span><span>Tous les liens étaient déjà importés ou ont échoué.</span>
      </div>`;

  renderSavedArticles();
  renderValidationQueue();
  updateStats();

  if (added > 0) {
    showToast(`✅ ${added} article${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''} en validation`, 'success');
    document.getElementById('paste-text-input').value = '';
  }
}

// ============ UTILS ============
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function getWeekYear(d) {
  // Returns the ISO week year (can differ from calendar year in Jan/Dec)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return date.getUTCFullYear();
}

// Returns "S17-2026" style key for grouping
function weekKey(article) {
  const w = article.week || getWeekNumber(new Date(article.publicationDate || article.date));
  const y = article.weekYear || getWeekYear(new Date(article.publicationDate || article.date));
  return `S${String(w).padStart(2,'0')}-${y}`;
}

// Returns "Semaine 17 — 2026" for display
function weekLabel(article) {
  const w = article.week || getWeekNumber(new Date(article.publicationDate || article.date));
  const y = article.weekYear || getWeekYear(new Date(article.publicationDate || article.date));
  return `Semaine ${w} — ${y}`;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch(e) { return iso; }
}

// Label de date d'un article : date de publication si connue, sinon "Date non précisée"
// (ne retombe JAMAIS sur la date d'import pour éviter d'afficher une fausse date)
function publicationDateLabel(article, withIcon = true) {
  if (article.publicationDate) {
    return (withIcon ? '📅 ' : '') + formatDate(article.publicationDate);
  }
  return (withIcon ? '❔ ' : '') + 'Date non précisée';
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function domainClass(domain) {
  if (!domain) return '';
  return domain.toLowerCase().replace(/\s+/g, '-').replace(/é|è|ê/g, 'e').replace(/[^a-z-]/g, '');
}

function statusClass(status) {
  const map = { 'NEW': 'new', 'PENDING_REVIEW': 'pending', 'VALIDATED': 'validated', 'REJECTED': 'rejected', 'DUPLICATE_SUSPECTED': 'duplicate', 'MERGED': 'merged', 'CAPITALISED': 'validated' };
  return map[status] || 'new';
}

function statusLabel(status) {
  const map = { 'NEW': 'Nouveau', 'PENDING_REVIEW': 'En attente', 'VALIDATED': 'Validé', 'REJECTED': 'Rejeté', 'DUPLICATE_SUSPECTED': 'Doublon ?', 'MERGED': 'Fusionné', 'CAPITALISED': 'Capitalisé' };
  return map[status] || status;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || '•'}</span> <span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; toast.style.transition = '0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function showLoading(text = 'Chargement...') {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function clearImportForm() {
  document.getElementById('article-url').value = '';
  const domainEl = document.getElementById('article-domain');
  if (domainEl) domainEl.value = '';
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function toggleVisibility(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function updateStats() {
  const total = state.articles.filter(a => a.status !== 'REJECTED').length;
  const pending = state.articles.filter(a => ['PENDING_REVIEW', 'NEW', 'DUPLICATE_SUSPECTED'].includes(a.status)).length;

  const badge = document.getElementById('validation-badge');
  if (badge) badge.textContent = pending;

  const totalStat = document.getElementById('total-articles-stat');
  const domainStat = document.getElementById('total-domains-stat');
  if (totalStat) totalStat.textContent = state.articles.filter(a => a.status === 'VALIDATED').length;
  if (domainStat) {
    const domains = new Set(state.articles.filter(a => a.status === 'VALIDATED').map(a => a.domain));
    domainStat.textContent = domains.size;
  }
}

function renderAllViews() {
  renderSavedArticles();
  renderFeaturedArticles();
  renderValidationQueue();
  updateStats();
}

// Global search
document.getElementById('global-search').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('.article-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? '' : 'none';
  });
});


// ============ DEMO DATA (première ouverture uniquement) ============
function injectDemoData() {
  state.articles = [
    {
      id: generateId(),
      url: 'https://example.com/article1',
      title: 'Mistral AI lève 600M€ pour développer des LLMs souverains',
      titleFr: 'Mistral AI lève 600M€ pour développer des LLMs souverains',
      content: '',
      domain: 'Entreprise',
      status: 'VALIDATED',
      date: new Date(Date.now() - 3 * 24 * 3600000).toISOString(),
      week: getWeekNumber(new Date()),
      month: new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: true,
      summary: 'Mistral AI réalise une levée de fonds historique de 600M€, consolidant sa position de leader européen dans l\'IA générative face aux géants américains.',
      keyPoints: [
        '👩🏻‍🚀 Valorisation atteint 6 milliards d\'euros post-levée',
        '🦠 Investisseurs incluent General Catalyst et Andreessen Horowitz',
        '🪐 Objectif : déploiement de modèles 100% souverains pour l\'Europe',
        '⚡ Concurrence directe avec GPT-4 et Gemini Ultra',
        '🔬 Partenariat renforcé avec Microsoft Azure pour le déploiement'
      ]
    },
    {
      id: generateId(),
      url: 'https://example.com/article2',
      title: 'L\'armée française déploie des drones IA pour la surveillance des frontières',
      titleFr: 'L\'armée française déploie des drones IA pour la surveillance des frontières',
      content: '',
      domain: 'Défense',
      status: 'VALIDATED',
      date: new Date(Date.now() - 7 * 24 * 3600000).toISOString(),
      week: getWeekNumber(new Date()) - 1,
      month: new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: false,
      summary: 'Le ministère des Armées déploie des drones IA Thales pour la surveillance automatisée des frontières.',
      keyPoints: [
        '🪖 Flotte de 45 drones autonomes déployée sur les frontières Est',
        '🤖 Système de reconnaissance d\'image avec 94% de précision',
        '🛡 Fabricant : Thales avec support de l\'algorithme DGA',
        '⚡ Temps de détection réduit de 8 minutes à 45 secondes',
        '🌍 Interopérabilité avec le système OTAN Frontex'
      ]
    },
    {
      id: generateId(),
      url: 'https://example.com/article3',
      title: 'NVIDIA annonce le GPU H200 pour l\'entraînement de modèles IA',
      titleFr: 'NVIDIA annonce le GPU H200 pour l\'entraînement de modèles IA',
      content: '',
      domain: 'Hardware',
      status: 'VALIDATED',
      date: new Date(Date.now() - 5 * 24 * 3600000).toISOString(),
      week: getWeekNumber(new Date()),
      month: new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: false,
      summary: 'Le GPU H200 de NVIDIA révolutionne l\'entraînement des LLMs avec 141 Go de mémoire HBM3e.',
      keyPoints: [
        '💻 141 Go de mémoire HBM3e — record absolu pour un GPU IA',
        '⚡ Bande passante mémoire de 4.8 TB/s',
        '🪐 Disponible en configuration SXM5 et PCIe',
        '💰 Prix estimé entre 30 000 et 40 000 $ l\'unité',
        '🤖 Compatible avec tous les frameworks IA majeurs'
      ]
    },
    {
      id: generateId(),
      url: 'https://example.com/article4',
      title: 'L\'UE publie le règlement IA Act : nouvelles contraintes pour les entreprises',
      titleFr: 'L\'UE publie le règlement IA Act : nouvelles contraintes pour les entreprises',
      content: '',
      domain: 'Juridique',
      status: 'PENDING_REVIEW',
      date: new Date().toISOString(),
      week: getWeekNumber(new Date()),
      month: new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: false,
      summary: 'L\'AI Act européen établit un cadre réglementaire par niveaux de risque, imposant des obligations strictes aux systèmes d\'IA à haut risque.',
      keyPoints: [
        '⚖ Système de classification par niveau de risque : minimal, limité, élevé, inacceptable',
        '🔬 Audit obligatoire pour les systèmes IA à haut risque avant déploiement',
        '👩🏻‍🚀 Amendes jusqu\'à 35M€ ou 7% du CA mondial',
        '🪐 Entrée en vigueur progressive : 6, 12, 24 et 36 mois',
        '🌍 Toutes les entreprises opérant dans l\'UE concernées'
      ]
    }
  ];
  saveToStorage();
}

// ============================================================
// RSS FEED MANAGEMENT
// ============================================================

const AI_KEYWORDS = [
  'intelligence artificielle', 'artificial intelligence', ' ai ', ' ia ',
  'machine learning', 'deep learning', 'llm', 'gpt', 'chatgpt', 'mistral',
  'neural network', 'réseau de neurones', 'chatbot', 'language model',
  'openai', 'anthropic', 'google deepmind', 'generative ai', 'ia générative',
  'robot', 'automation', 'algorithme', 'algorithm', 'données', 'data science',
  'nvidia', 'gpu training', 'transformer', 'diffusion model', 'stable diffusion'
];

function isAiRelated(text) {
  const lower = (text || '').toLowerCase();
  return AI_KEYWORDS.some(kw => lower.includes(kw));
}

function addRssFeed() {
  const urlInput = document.getElementById('rss-url-input');
  const nameInput = document.getElementById('rss-name-input');
  const url = urlInput.value.trim();
  const name = nameInput.value.trim();

  if (!url) { showToast('⚠ Entrez une URL de flux RSS', 'warning'); return; }
  try { new URL(url); } catch(e) { showToast('⚠ URL invalide', 'warning'); return; }

  if (state.rssFeeds.find(f => f.url === url)) {
    showToast('⚠ Ce flux est déjà dans votre liste', 'warning'); return;
  }

  state.rssFeeds.push({
    id: generateId(),
    url,
    name: name || extractDomainName(url),
    enabled: true,
    lastFetch: null,
    articlesFound: 0
  });

  urlInput.value = '';
  nameInput.value = '';
  saveToStorage();
  renderRssTab();
  showToast('✅ Flux ajouté', 'success');
}

function extractDomainName(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch(e) { return url; }
}

function removeRssFeed(id) {
  state.rssFeeds = state.rssFeeds.filter(f => f.id !== id);
  saveToStorage();
  renderRssTab();
  showToast('🗑 Flux supprimé', 'warning');
}

function toggleRssFeedEnabled(id, enabled) {
  const feed = state.rssFeeds.find(f => f.id === id);
  if (feed) { feed.enabled = enabled; saveToStorage(); }
}

function toggleRssAuto(enabled) {
  state.settings.rssAutoFetch = enabled;
  saveToStorage();
  if (enabled) scheduleRssAutoFetch();
  showToast(enabled ? '✅ Récupération auto activée (1×/jour)' : '⏹ Récupération auto désactivée', enabled ? 'success' : 'warning');
}

// Schedule auto-fetch once per day
let rssAutoFetchTimer = null;
function scheduleRssAutoFetch() {
  if (rssAutoFetchTimer) clearTimeout(rssAutoFetchTimer);
  if (!state.settings.rssAutoFetch) return;

  const last = state.settings.lastAutoFetch ? new Date(state.settings.lastAutoFetch) : null;
  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const msSinceLast = last ? (now - last) : oneDayMs + 1;

  if (msSinceLast >= oneDayMs) {
    // Run immediately
    fetchAllFeeds(false);
  } else {
    // Schedule for remaining time
    const remaining = oneDayMs - msSinceLast;
    rssAutoFetchTimer = setTimeout(() => fetchAllFeeds(false), remaining);
  }
}

async function fetchAllFeeds(showUI = true) {
  if (state.rssFeeds.filter(f => f.enabled).length === 0) {
    if (showUI) showToast('⚠ Aucun flux RSS actif. Ajoutez des flux d\'abord.', 'warning');
    return;
  }
  if (!state.settings.mistralKey) {
    showToast('⚠ Clé Mistral requise pour analyser les articles RSS', 'warning');
    return;
  }
  if (showUI) showLoading('Scan des flux RSS en cours...');

  let totalNew = 0;
  const enabledFeeds = state.rssFeeds.filter(f => f.enabled);

  for (const feed of enabledFeeds) {
    try {
      if (showUI) showLoading(`Lecture : ${feed.name}...`);
      const items = await fetchRssFeed(feed.url);
      const aiItems = items.filter(item => isAiRelated(item.title + ' ' + item.description));

      // Filter already imported URLs — inclure TOUS les articles même capitalisés/rejetés
      // pour éviter de réimporter des articles déjà traités
      const existingUrls = new Set(
        state.articles
          .filter(a => a.url)
          .map(a => normalizeUrl(a.url))
      );
      const newItems = aiItems.filter(item =>
        item.link && !existingUrls.has(normalizeUrl(item.link))
      );

      feed.articlesFound = aiItems.length;
      feed.lastFetch = new Date().toISOString();

      for (const item of newItems.slice(0, 5)) {
        const pubD = item.pubDate ? (() => {
          try { const d = new Date(item.pubDate); return isNaN(d.getTime()) ? null : d; }
          catch(e) { return null; }
        })() : null;
        const refDate = pubD || new Date();
        const article = {
          id: generateId(),
          url: item.link,
          title: item.title || 'Article RSS',
          titleFr: item.title || 'Article RSS',
          content: item.description || '',
          domain: detectDomain(item.title + ' ' + item.description),
          status: 'PENDING_REVIEW',
          date: new Date().toISOString(),
          publicationDate: pubD ? pubD.toISOString() : null,
          week: getWeekNumber(refDate),
          weekYear: getWeekYear(refDate),
          month: refDate.toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
          favorite: false,
          summary: '',
          keyPoints: [],
          fromRss: true,
          rssSource: feed.name,
          updatedAt: new Date().toISOString()
        };

        // Vérification doublon de contenu (titre/résumé similaire)
        const dup = findDuplicate(article);
        if (dup) {
          article.status = 'DUPLICATE_SUSPECTED';
          state.currentDuplicateCheck = { new: article, existing: dup.article, score: dup.score };
        }
        state.articles.push(article);
        totalNew++;
      }

    } catch(err) {
      console.warn(`Feed error for ${feed.url}:`, err.message);
      feed.lastFetch = new Date().toISOString();
    }
  }

  state.settings.lastAutoFetch = new Date().toISOString();
  saveToStorage();
  if (showUI) hideLoading();

  renderRssTab();
  renderSavedArticles();
  renderValidationQueue();
  updateStats();

  if (totalNew > 0) {
    const badge = document.getElementById('rss-badge');
    if (badge) { badge.textContent = totalNew; badge.classList.remove('hidden'); }
    showToast(`✅ ${totalNew} nouvel${totalNew > 1 ? 's' : ''} article${totalNew > 1 ? 's' : ''} IA détecté${totalNew > 1 ? 's' : ''} — génération des résumés...`, 'success');
    // Génération automatique des résumés (await pour traiter tous les articles)
    await generateRssSummaries(false);
  } else {
    showToast('ℹ Aucun nouvel article IA trouvé', 'info');
  }

  // Reschedule auto-fetch
  scheduleRssAutoFetch();
}

// ── Fetch avec 3 proxies en cascade ──────────────────────────
const RSS_PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`
];

async function fetchRssFeed(feedUrl) {
  let lastErr = null;

  for (let i = 0; i < RSS_PROXIES.length; i++) {
    try {
      const proxyUrl = RSS_PROXIES[i](feedUrl);
      const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(14000) });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // allorigins wraps in JSON {contents:...}, others return raw XML
      const text = await resp.text();
      let xml = text;
      try {
        const json = JSON.parse(text);
        xml = json.contents || json.data || text;
      } catch(e) { /* raw XML, keep as-is */ }

      if (!xml || xml.trim().length < 30) throw new Error('Réponse vide');

      const items = parseRssXml(xml);
      if (items.length === 0 && xml.includes('<error')) throw new Error('Feed bloqué par le proxy');

      return items;
    } catch(e) {
      lastErr = e;
      console.warn(`Proxy ${i + 1} failed for ${feedUrl}:`, e.message);
    }
  }
  throw new Error(`Impossible de lire le flux (${lastErr?.message || 'tous les proxies ont échoué'})`);
}

// ── Parseur RSS/Atom robuste ──────────────────────────────────
function parseRssXml(xml) {
  // Remove BOM and normalize
  xml = xml.replace(/^\uFEFF/, '').trim();

  // If allorigins double-encoded HTML entities, decode them
  if (xml.startsWith('&lt;') || xml.startsWith('%3C')) {
    const tmp = document.createElement('textarea');
    tmp.innerHTML = xml;
    xml = tmp.value;
    xml = decodeURIComponent(xml.replace(/\+/g, ' '));
  }

  const parser = new DOMParser();
  let doc = parser.parseFromString(xml, 'application/xml');

  // Fallback: if XML parse fails try text/html
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    doc = parser.parseFromString(xml, 'text/html');
  }

  const items = [];

  // ── Helper: get text from element, handles CDATA ──
  const getText = (el, ...selectors) => {
    for (const sel of selectors) {
      try {
        // Try standard querySelector
        const found = el.querySelector(sel);
        if (found) {
          const t = (found.textContent || found.innerHTML || '').trim();
          if (t) return t;
        }
      } catch(e) {}
    }
    return '';
  };

  // ── Helper: get link from <link> or <guid isPermaLink> ──
  const getLink = (el) => {
    // atom <link href="...">
    const atomLink = el.querySelector('link[href]');
    if (atomLink) return atomLink.getAttribute('href');

    // RSS <link>TEXT</link>  (often right after <title>)
    const linkEl = el.querySelector('link');
    if (linkEl) {
      const t = linkEl.textContent.trim();
      if (t.startsWith('http')) return t;
      // sometimes <link/> is self-closing and next sibling is the URL as text
    }

    // Regex fallback on raw XML snippet for this item
    const raw = el.outerHTML || el.innerHTML || '';
    const m = raw.match(/<link[^>]*>([^<]+)<\/link>/) ||
              raw.match(/<link[^>]*href="([^"]+)"/) ||
              raw.match(/<guid[^>]*>([^<]+)<\/guid>/);
    if (m && m[1].startsWith('http')) return m[1].trim();

    return '';
  };

  // ── Helper: extract pubDate ──
  const getPubDate = (el) => {
    return getText(el, 'pubDate', 'published', 'updated', 'dc\\:date', 'date') ||
           el.querySelector('[localName="date"]')?.textContent?.trim() || '';
  };

  // ── Helper: extract best description ──
  const getDesc = (el) => {
    // Prefer content:encoded (full article text)
    const raw = el.outerHTML || '';
    const ceMatch = raw.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
    if (ceMatch) return stripHtml(ceMatch[1]);

    const summaryMatch = raw.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/i);
    if (summaryMatch) return stripHtml(summaryMatch[1]);

    return stripHtml(getText(el, 'description', 'summary', 'content'));
  };

  // ── RSS 2.0 ──
  doc.querySelectorAll('channel > item, rss item').forEach(item => {
    const title = stripHtml(getText(item, 'title'));
    const link  = getLink(item);
    const desc  = getDesc(item);
    const date  = getPubDate(item);
    if (title || link) items.push({ title, link, description: desc, pubDate: date });
  });

  // ── Atom ──
  if (items.length === 0) {
    doc.querySelectorAll('feed > entry, entry').forEach(entry => {
      const title = stripHtml(getText(entry, 'title'));
      const link  = getLink(entry);
      const desc  = getDesc(entry);
      const date  = getPubDate(entry);
      if (title || link) items.push({ title, link, description: desc, pubDate: date });
    });
  }

  // ── Last resort: regex on raw XML ──
  if (items.length === 0) {
    const itemMatches = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
    for (const m of itemMatches) {
      const block = m[1];
      const title = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
                     block.match(/<title[^>]*>([^<]+)<\/title>/i))?.[1]?.trim() || '';
      const link  = (block.match(/<link[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i) ||
                     block.match(/<link[^>]*>([^<]+)<\/link>/i) ||
                     block.match(/<guid[^>]*>([^<]+)<\/guid>/i))?.[1]?.trim() || '';
      const desc  = stripHtml((block.match(/<content:encoded[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/i) ||
                     block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/i) ||
                     block.match(/<description[^>]*>([^<]+)<\/description>/i))?.[1] || '');
      const date  = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) ||
                     block.match(/<dc:date[^>]*>([^<]+)<\/dc:date>/i))?.[1]?.trim() || '';
      if (title || (link && link.startsWith('http'))) {
        items.push({ title, link: link.startsWith('http') ? link : '', description: desc, pubDate: date });
      }
    }
  }

  return items;
}

function stripHtml(html = '') {
  return (html || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
    .substring(0, 600);
}

async function generateRssSummaries(showProgress = false) {
  const pending = state.articles.filter(
    a => (a.fromRss || !a.summary) && a.status === 'PENDING_REVIEW' && !a.summary
  );
  if (pending.length === 0) {
    if (showProgress) showToast('ℹ Tous les articles ont déjà un résumé', 'info');
    return;
  }

  const total = pending.length;
  let done = 0;
  let errors = 0;

  if (showProgress) showLoading(`Génération des résumés : 0 / ${total}...`);

  for (const article of pending) {
    try {
      if (showProgress) showLoading(`Génération des résumés : ${done} / ${total}...`);
      const result = await generateSummaryWithMistral(article);
      article.titleFr      = result.titleFr   || article.title;
      article.title        = article.titleFr;
      article.summary      = result.summary   || '';
      article.keyPoints    = result.keyPoints || [];
      article.defenseTable = result.defenseTable || null;
      if (result.domain) article.domain = result.domain;
      if (result.publicationDate) {
        try {
          const d = new Date(result.publicationDate);
          if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
            article.publicationDate = d.toISOString();
            article.week     = getWeekNumber(d);
            article.weekYear = getWeekYear(d);
            article.month    = d.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
          }
        } catch(e) {}
      }
      done++;
      saveToStorage();
      // Refresh UI progressively so user sees summaries appearing
      renderRssDetectedArticles();
      renderValidationQueue();
      // Mistral rate-limit: 1 request/sec on free tier, 500ms margin
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      errors++;
      console.warn('RSS summary error:', article.title, e.message);
      // On rate limit (429) wait longer before retrying next
      if (e.message.includes('429')) await new Promise(r => setTimeout(r, 5000));
      else await new Promise(r => setTimeout(r, 800));
    }
  }

  if (showProgress) hideLoading();
  saveToStorage();
  renderRssTab();
  renderValidationQueue();
  renderSavedArticles();

  if (showProgress) {
    if (errors === 0) showToast(`✅ ${done} résumé${done > 1 ? 's' : ''} généré${done > 1 ? 's' : ''}`, 'success');
    else showToast(`⚠ ${done} résumé${done > 1 ? 's' : ''} généré${done > 1 ? 's' : ''}, ${errors} erreur${errors > 1 ? 's' : ''}`, 'warning');
  }
}

// Bouton manuel "Forcer la génération"
async function forceGenerateSummaries() {
  if (!state.settings.mistralKey) {
    showToast('⚠ Clé API Mistral requise dans Paramètres', 'warning');
    return;
  }
  await generateRssSummaries(true);
}

function validateAllRss() {
  const rssArticles = state.articles.filter(a => a.fromRss && a.status === 'PENDING_REVIEW');
  rssArticles.forEach(a => { a.status = 'VALIDATED'; });
  saveToStorage();
  renderRssTab();
  renderValidationQueue();
  renderSavedArticles();
  updateStats();
  showToast(`✅ ${rssArticles.length} article${rssArticles.length > 1 ? 's' : ''} validé${rssArticles.length > 1 ? 's' : ''}`, 'success');
}

function renderRssTab() {
  renderRssFeedsList();
  renderRssDetectedArticles();
  renderRssStats();
}

let rssFeedsPage = 0;
const RSS_FEEDS_PER_PAGE = 10;

function renderRssFeedsList(page = 0) {
  rssFeedsPage = page;
  const container = document.getElementById('rss-feeds-list');
  const countEl   = document.getElementById('rss-feeds-count');
  if (!container) return;

  // Tri alphabétique par nom
  const sorted = [...state.rssFeeds].sort((a, b) =>
    (a.name || a.url).localeCompare(b.name || b.url, 'fr', { sensitivity: 'base' })
  );

  if (countEl) countEl.textContent = `${sorted.length} flux`;

  if (sorted.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><p>Aucun flux RSS configuré</p><span>Ajoutez vos premiers flux ci-dessus</span></div>`;
    return;
  }

  const totalPages = Math.ceil(sorted.length / RSS_FEEDS_PER_PAGE);
  const paginated  = sorted.slice(page * RSS_FEEDS_PER_PAGE, (page + 1) * RSS_FEEDS_PER_PAGE);

  const pagination = totalPages > 1 ? `
    <div class="pagination" style="padding:10px 0 4px">
      <button class="btn-secondary small" onclick="renderRssFeedsList(${page - 1})" ${page === 0 ? 'disabled' : ''}>← Préc.</button>
      <span class="page-info">${page + 1} / ${totalPages} <span style="color:var(--text-muted)">(${sorted.length} flux)</span></span>
      <button class="btn-secondary small" onclick="renderRssFeedsList(${page + 1})" ${page >= totalPages - 1 ? 'disabled' : ''}>Suiv. →</button>
    </div>
  ` : '';

  container.innerHTML = pagination + paginated.map(feed => `
    <div class="rss-feed-row ${feed.enabled ? '' : 'disabled'}">
      <div style="flex-shrink:0">
        <label class="toggle-switch">
          <input type="checkbox" ${feed.enabled ? 'checked' : ''} onchange="toggleRssFeedEnabled('${feed.id}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="rss-feed-info">
        <div class="rss-feed-name">${escHtml(feed.name)}</div>
        <div class="rss-feed-url">${escHtml(feed.url)}</div>
      </div>
      <div class="rss-feed-meta">
        ${feed.articlesFound > 0 ? `<span class="rss-count-badge">${feed.articlesFound} IA</span>` : ''}
        <span class="rss-last-fetch">${feed.lastFetch ? 'Scanné ' + formatDate(feed.lastFetch) : 'Jamais scanné'}</span>
        <button class="action-btn" onclick="testFeedUrl('${feed.id}')" title="Tester">🔌</button>
        <button class="action-btn" onclick="removeRssFeed('${feed.id}')" title="Supprimer">🗑</button>
      </div>
    </div>
  `).join('') + (totalPages > 1 ? pagination : '');
}

function renderRssDetectedArticles() {
  const container = document.getElementById('rss-detected-articles');
  if (!container) return;
  const rssArticles = state.articles.filter(a => a.fromRss && a.status === 'PENDING_REVIEW');
  if (rssArticles.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Aucun article détecté</p><span>Lancez un scan pour récupérer les articles</span></div>`;
    return;
  }
  container.innerHTML = rssArticles.map(a => `
    <div class="article-card">
      <div class="article-card-header">
        <div class="article-card-title" onclick="openArticleModal('${a.id}')">${escHtml(a.titleFr || a.title)}</div>
        <div class="article-card-actions">
          <button class="action-btn" onclick="validateArticle('${a.id}')" title="Valider" style="color:var(--success)">✅</button>
          <button class="action-btn" onclick="openArticleModal('${a.id}')" title="Voir">👁</button>
          <button class="action-btn" onclick="rejectArticleById('${a.id}')" title="Rejeter" style="color:var(--danger)">❌</button>
        </div>
      </div>
      <div class="article-card-meta">
        <span class="domain-badge ${domainClass(a.domain)}">${DOMAIN_ICONS[a.domain] || ''} ${a.domain}</span>
        <span style="font-size:10px;color:var(--text-muted);padding:2px 7px;background:var(--navy);border-radius:4px">📡 ${escHtml(a.rssSource || 'RSS')}</span>
        <span class="article-date">${a.publicationDate ? '📅 ' + formatDate(a.publicationDate) : '⬇ ' + formatDate(a.date)}</span>
        ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" style="font-size:11px;color:var(--accent)">🔗</a>` : ''}
      </div>
      ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : `<div class="article-summary-preview" style="color:var(--text-muted);font-style:italic">Résumé en cours de génération...</div>`}
    </div>
  `).join('');
}

function renderRssStats() {
  const lastFetchEl = document.getElementById('rss-last-fetch-label');
  const foundEl = document.getElementById('rss-found-count');
  const activeEl = document.getElementById('rss-active-count');
  const autoBadge = document.getElementById('rss-auto-status-badge');
  const autoToggle = document.getElementById('rss-auto-toggle');

  if (lastFetchEl) lastFetchEl.textContent = state.settings.lastAutoFetch ? formatDate(state.settings.lastAutoFetch) : 'Jamais';
  if (foundEl) foundEl.textContent = state.rssFeeds.reduce((s, f) => s + (f.articlesFound || 0), 0);
  if (activeEl) activeEl.textContent = state.rssFeeds.filter(f => f.enabled).length;
  if (autoBadge) {
    autoBadge.textContent = state.settings.rssAutoFetch ? 'Active' : 'Inactive';
    autoBadge.style.background = state.settings.rssAutoFetch ? 'rgba(52,211,153,0.15)' : 'rgba(90,106,122,0.2)';
    autoBadge.style.color = state.settings.rssAutoFetch ? 'var(--success)' : 'var(--text-muted)';
  }
  if (autoToggle) autoToggle.checked = !!state.settings.rssAutoFetch;
}

async function testFeedUrl(id) {
  const feed = state.rssFeeds.find(f => f.id === id);
  if (!feed) return;
  showLoading(`Test du flux : ${feed.name}...`);
  try {
    const items = await fetchRssFeed(feed.url);
    hideLoading();
    const aiItems = items.filter(i => isAiRelated(i.title + ' ' + i.description));
    const preview = items.slice(0, 3).map(i => `• ${i.title || i.link}`).join('\n');
    showToast(
      `✅ ${items.length} articles — ${aiItems.length} liés à l'IA\n${preview}`,
      'success'
    );
  } catch(e) {
    hideLoading();
    showToast('❌ Flux inaccessible : ' + e.message, 'error');
  }
}

// ============================================================
// GITHUB GIST SYNC — credentials saisis par l'utilisateur
// ============================================================
const GIST = {
  get token()  { return localStorage.getItem('gist_token')  || ''; },
  get gistId() { return localStorage.getItem('gist_id')     || ''; },
  get file()   { return localStorage.getItem('gist_file')   || 'ia_platform_data.json'; },
  set file(v)  { localStorage.setItem('gist_file', v); }
};

function gistConfigured() {
  return !!(GIST.token && GIST.gistId);
}

// Headers calculés dynamiquement à chaque appel (token lu depuis localStorage)
function gistHeaders() {
  return {
    'Authorization': `token ${GIST.token}`,
    'Accept':        'application/vnd.github+json',
    'Content-Type':  'application/json'
  };
}

// ── PULL : lire le Gist ──────────────────────────────────────
// gistPullRaw : version complète qui détecte la troncature du contenu par l'API GitHub
// GitHub tronque le champ "content" des fichiers > ~1Mo dans la réponse JSON du Gist.
// Dans ce cas, il faut re-télécharger le contenu complet via raw_url.
async function gistPullRaw() {
  const resp = await fetch(`https://api.github.com/gists/${GIST.gistId}`, {
    headers: gistHeaders()
  });

  if (resp.status === 401) throw new Error('Token GitHub invalide ou expiré (401) — vérifiez le scope "gist" sur github.com/settings/tokens');
  if (resp.status === 403) throw new Error('Accès refusé (403) — token sans permission gist');
  if (resp.status === 404) throw new Error('Gist introuvable (404) — vérifiez l\'ID du Gist');
  if (!resp.ok) throw new Error(`Gist pull HTTP ${resp.status}`);

  const data = await resp.json();

  // Cherche le fichier par nom exact, puis par extension .json en fallback
  let file = data.files?.[GIST.file];
  if (!file) {
    file = Object.values(data.files || {}).find(f => f.filename.endsWith('.json'));
    if (file) {
      GIST.file = file.filename;
      console.log('[SYNC] Fichier trouvé par fallback :', file.filename);
    }
  }
  if (!file) return { data: null, truncated: false };

  let raw = file.content;

  // Si GitHub a tronqué le contenu, on récupère le contenu complet via raw_url
  if (file.truncated && file.raw_url) {
    console.log('[SYNC] Contenu tronqué détecté, récupération via raw_url...');
    try {
      const rawResp = await fetch(file.raw_url, { headers: gistHeaders() });
      if (rawResp.ok) {
        raw = await rawResp.text();
      } else {
        return { data: null, truncated: true };
      }
    } catch(e) {
      return { data: null, truncated: true };
    }
  }

  if (!raw) return { data: null, truncated: false };
  try {
    return { data: JSON.parse(raw), truncated: false };
  } catch(e) {
    console.warn('[SYNC] JSON.parse a échoué — le contenu est probablement tronqué/corrompu');
    return { data: null, truncated: true };
  }
}

// Wrapper conservé pour compatibilité avec d'anciens appels
async function gistPull() {
  const result = await gistPullRaw();
  return result.data;
}

// ── PUSH : écrire le Gist ────────────────────────────────────
async function gistPush(payload) {
  const resp = await fetch(`https://api.github.com/gists/${GIST.gistId}`, {
    method:  'PATCH',
    headers: gistHeaders(),
    body: JSON.stringify({
      files: {
        [GIST.file]: {
          content: JSON.stringify(payload, null, 2)
        }
      }
    })
  });
  if (!resp.ok) throw new Error(`Gist push HTTP ${resp.status}`);
  return resp.json();
}

// ── Merge articles : union par id, timestamp le plus récent gagne ──
function mergeArticles(local, remote) {
  const map = new Map(local.map(a => [a.id, a]));
  remote.forEach(ra => {
    if (!map.has(ra.id)) {
      map.set(ra.id, ra);
    } else {
      const localTs  = new Date(map.get(ra.id).updatedAt || map.get(ra.id).date || 0).getTime();
      const remoteTs = new Date(ra.updatedAt || ra.date || 0).getTime();
      if (remoteTs > localTs) map.set(ra.id, ra);
    }
  });
  return [...map.values()];
}

// ── Merge flux RSS ────────────────────────────────────────────
function mergeFeeds(local, remote) {
  const ids = new Set(local.map(f => f.id));
  remote.forEach(rf => { if (!ids.has(rf.id)) local.push(rf); });
  return local;
}

async function syncNow(silent = false) {
  const sidebarBtn = document.getElementById('sync-sidebar-btn');

  if (!gistConfigured()) {
    if (!silent) {
      showToast('⚠ Configurez le Gist dans Paramètres', 'warning');
      updateSyncUI(false, 'Token et Gist ID non configurés — allez dans Paramètres');
    }
    renderAllViews();
    updateStats();
    return;
  }

  if (sidebarBtn) sidebarBtn.classList.add('syncing');
  if (!silent) showLoading('Synchronisation Gist...');

  const resultEl = document.getElementById('sync-result');
  if (resultEl) resultEl.style.display = 'none';

  console.log('[SYNC] Démarrage — token:', GIST.token.substring(0,10)+'...', 'gistId:', GIST.gistId);

  try {
    const now = new Date().toISOString();
    state.articles.forEach(a => { if (!a.updatedAt) a.updatedAt = a.date || now; });

    // 1. PULL
    console.log('[SYNC] Pull depuis Gist...');
    const pullResult = await gistPullRaw();
    const remote = pullResult.data;
    console.log('[SYNC] Pull OK — articles distants:', remote?.articles?.length ?? 0, '| feeds:', remote?.rssFeeds?.length ?? 0, '| tronqué:', pullResult.truncated);

    if (pullResult.truncated) {
      // Le fichier distant dépasse la limite Gist (~1Mo) et a été tronqué par l'API GitHub.
      // On ne fusionne PAS dans ce cas pour éviter d'écraser des données avec un état incomplet.
      throw new Error('Le fichier Gist est trop volumineux et a été tronqué par GitHub (limite ~1 Mo). Les données distantes sont incomplètes — la sync a été annulée pour éviter une perte de données. Réduisez le nombre d\'articles ou contactez le support.');
    }

    // 2. MERGE
    const localCount = state.articles.length;
    const localFeedsCount = state.rssFeeds.length;

    if (remote) {
      if (Array.isArray(remote.articles) && remote.articles.length > 0) {
        state.articles = mergeArticles(state.articles, remote.articles);
      }
      if (Array.isArray(remote.rssFeeds) && remote.rssFeeds.length > 0) {
        state.rssFeeds = mergeFeeds(state.rssFeeds, remote.rssFeeds);
      }
      if (!state.settings.mistralKey && remote.settings?.mistralKey) {
        state.settings.mistralKey = remote.settings.mistralKey;
      }
    }

    const addedArticles = state.articles.length - localCount;
    const addedFeeds    = state.rssFeeds.length - localFeedsCount;
    console.log('[SYNC] Merge OK — +articles:', addedArticles, '| +feeds:', addedFeeds, '| total:', state.articles.length);

    // 3. PUSH
    console.log('[SYNC] Push vers Gist...');
    await gistPush({
      articles:  state.articles,
      rssFeeds:  state.rssFeeds,
      settings:  state.settings,
      updatedAt: now
    });
    console.log('[SYNC] Push OK');

    state.settings.lastSyncDate = now;
    try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}

    if (!silent) hideLoading();
    if (sidebarBtn) sidebarBtn.classList.remove('syncing');
    renderAllViews();
    updateStats();
    updateSyncUI(true);

    const msg = addedArticles > 0 || addedFeeds > 0
      ? `☁ Sync OK — +${addedArticles} article(s), +${addedFeeds} flux RSS (total : ${state.articles.length})`
      : `☁ Synchronisation OK — ${state.articles.length} articles à jour`;
    if (!silent) showToast(msg, 'success');

  } catch(e) {
    if (!silent) hideLoading();
    if (sidebarBtn) sidebarBtn.classList.remove('syncing');
    console.error('[SYNC] Erreur:', e.message);
    renderAllViews();
    updateStats();
    updateSyncUI(false, e.message);
    if (!silent) showToast('⚠ Sync : ' + e.message, 'warning');
  }
}

// ── Push direct après suppression (sans debounce) ────────────
async function _pushToSupabase() {   // gardé pour compatibilité avec deleteArticle
  const now = new Date().toISOString();
  state.articles.forEach(a => { if (!a.updatedAt) a.updatedAt = a.date || now; });
  try {
    await gistPush({
      articles:  state.articles,
      rssFeeds:  state.rssFeeds,
      settings:  state.settings,
      updatedAt: now
    });
    state.settings.lastSyncDate = now;
    try { localStorage.setItem('ia_platform_data', JSON.stringify(state)); } catch(e) {}
    updateSyncUI(true);
  } catch(e) {
    console.error('Gist push error:', e);
  }
}

// ── Sync différée après chaque modif (debounce 3 s) ──────────
function syncAfterChange() {
  clearTimeout(syncAfterChange._timer);
  syncAfterChange._timer = setTimeout(() => syncNow(true), 3000);
}

// ── UI sync ──────────────────────────────────────────────────
function updateSyncUI(success, errMsg) {
  try {
    const label      = document.getElementById('sync-status-label');
    const lastSyncEl = document.getElementById('sb-last-sync');
    const gistIdEl   = document.getElementById('sb-project-name');
    const resultEl   = document.getElementById('sync-result');
    const tokenEl    = document.getElementById('sync-token-status');
    const countEl    = document.getElementById('sync-articles-count');

    const configured = gistConfigured();

    if (label) {
      if (!configured)   { label.textContent = '⚠ Non configuré'; label.style.color = 'var(--warning)'; }
      else if (success)  { label.textContent = '✅ Synchronisé';   label.style.color = 'var(--success)'; }
      else               { label.textContent = '❌ Erreur';        label.style.color = 'var(--danger)';  }
    }
    if (tokenEl)   tokenEl.textContent   = configured ? '✅ Token configuré (' + GIST.token.substring(0,8) + '...)' : '❌ Token manquant';
    if (lastSyncEl) lastSyncEl.textContent = state.settings?.lastSyncDate ? formatDate(state.settings.lastSyncDate) : 'Jamais';
    if (gistIdEl)  gistIdEl.textContent  = GIST.gistId ? GIST.gistId.substring(0, 16) + '...' : '—';
    if (countEl)   countEl.textContent   = `${state.articles.length} articles, ${state.rssFeeds.length} flux RSS`;

    if (resultEl) {
      if (errMsg) {
        resultEl.innerHTML    = `❌ ${escHtml(errMsg)}<br><small style="color:var(--text-muted)">Vérifiez le token et le Gist ID puis cliquez Sauvegarder.</small>`;
        resultEl.className    = 'connection-status error';
        resultEl.style.display = 'block';
      } else if (success) {
        resultEl.textContent   = `✅ ${state.articles.length} articles synchronisés`;
        resultEl.className     = 'connection-status success';
        resultEl.style.display = 'block';
      } else {
        resultEl.style.display = 'none';
      }
    }
  } catch(e) {
    // Ne jamais planter l'app à cause de l'UI de sync
    console.warn('updateSyncUI error:', e.message);
  }
}

// Stubs HTML
function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }

function saveGistConfig() {
  const token  = document.getElementById('gist-token-input').value.trim();
  const gistId = document.getElementById('gist-id-input').value.trim();
  const file   = document.getElementById('gist-file-input').value.trim() || 'ia_platform_data.json';

  if (!token || !gistId) {
    showToast('⚠ Token et Gist ID sont obligatoires', 'warning');
    return;
  }

  localStorage.setItem('gist_token',  token);
  localStorage.setItem('gist_id',     gistId);
  localStorage.setItem('gist_file',   file);

  // Effacer les champs pour ne pas exposer le token
  document.getElementById('gist-token-input').value = '';
  document.getElementById('gist-id-input').value    = gistId;   // garder l'ID visible
  document.getElementById('gist-file-input').value  = file;

  showToast('💾 Configuration Gist sauvegardée', 'success');
  updateSyncUI(false);
  syncNow(false);
}

async function testGistConnection() {
  if (!gistConfigured()) {
    showToast('⚠ Remplissez Token et Gist ID d\'abord', 'warning');
    return;
  }
  showLoading('Test de connexion Gist...');
  try {
    const resp = await fetch(`https://api.github.com/gists/${GIST.gistId}`, {
      headers: gistHeaders()
    });
    hideLoading();
    const statusEl = document.getElementById('gist-test-result');
    if (resp.ok) {
      const data = await resp.json();
      const files = Object.keys(data.files || {}).join(', ');
      if (statusEl) { statusEl.textContent = `✅ Connexion réussie — fichiers : ${files || '(vide)'}`; statusEl.className = 'connection-status success'; }
      showToast('✅ Gist accessible', 'success');
    } else if (resp.status === 401) {
      if (statusEl) { statusEl.textContent = '❌ Token invalide ou expiré (401)'; statusEl.className = 'connection-status error'; }
      showToast('❌ Token invalide (401)', 'error');
    } else if (resp.status === 404) {
      if (statusEl) { statusEl.textContent = '❌ Gist ID introuvable (404)'; statusEl.className = 'connection-status error'; }
      showToast('❌ Gist ID introuvable (404)', 'error');
    } else {
      if (statusEl) { statusEl.textContent = `❌ Erreur HTTP ${resp.status}`; statusEl.className = 'connection-status error'; }
    }
  } catch(e) {
    hideLoading();
    showToast('❌ Impossible de joindre GitHub : ' + e.message, 'error');
  }
}

function clearGistConfig() {
  if (!confirm('Supprimer la configuration Gist ? L\'app continuera en mode local.')) return;
  localStorage.removeItem('gist_token');
  localStorage.removeItem('gist_id');
  localStorage.removeItem('gist_file');
  document.getElementById('gist-token-input').value = '';
  document.getElementById('gist-id-input').value    = '';
  document.getElementById('gist-file-input').value  = 'ia_platform_data.json';
  updateSyncUI(false);
  showToast('🔌 Configuration Gist supprimée', 'warning');
}

function renderGistSettings() {
  const idEl    = document.getElementById('gist-id-input');
  const fileEl  = document.getElementById('gist-file-input');
  const countEl = document.getElementById('sync-articles-count');
  if (idEl   && GIST.gistId) idEl.value   = GIST.gistId;
  if (fileEl)                fileEl.value = GIST.file || 'ia_platform_data.json';
  if (countEl) countEl.textContent = `${state.articles.length} articles, ${state.rssFeeds.length} flux RSS`;
  updateSyncUI(gistConfigured() && !!state.settings.lastSyncDate);
}

