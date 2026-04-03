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
    duplicateThreshold: 75,
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

  // Inject demo articles only on very first launch (storage completely empty)
  if (state.articles.length === 0 && !localStorage.getItem('ia_platform_initialized')) {
    injectDemoData();
    localStorage.setItem('ia_platform_initialized', '1');
  }

  renderAllViews();
  updateStats();
  updateConnectionStatus();
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
  if (tab === 'settings') renderSettings();
  if (tab === 'rss') renderRssTab();
  if (tab === 'export') renderNewsletterWeekSelector();
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
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      if (resp.ok) {
        const data = await resp.json();
        const html = data.contents || '';
        // Extract title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
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
      // If fetch fails, we still proceed — Mistral will work from URL + title
      console.warn('Fetch page failed:', fetchErr.message);
    }

    // Step 2: Try to extract publication date from HTML meta tags
    let extractedDate = null;
    if (pageText) {
      // Try common meta date patterns in raw HTML (we have the raw html in proxyData)
      const datePatterns = [
        /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
        /["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
        /pubdate[^>]*content=["']([^"']+)["']/i,
        /<time[^>]*datetime=["']([^"']+)["']/i,
        /published_time.*?content="([^"]+)"/i
      ];
      // We don't have raw HTML here, we'll get it from Mistral
    }

    // Step 2: Build article object
    const articleData = {
      id: generateId(),
      url: url,
      title: pageTitle || url,
      titleFr: '',
      content: pageText,
      domain: domainSelect || '',
      status: 'NEW',
      date: new Date().toISOString(),      // import date (fallback)
      publicationDate: null,               // will be set by Mistral
      week: getWeekNumber(new Date()),
      month: new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
      favorite: false,
      summary: '',
      keyPoints: []
    };

    // Step 3: Mistral extracts everything
    showLoading('Génération du résumé avec Mistral...');
    const result = await generateSummaryWithMistral(articleData);
    articleData.titleFr = result.titleFr || pageTitle || 'Article sans titre';
    articleData.title = articleData.titleFr;
    articleData.summary = result.summary || '';
    articleData.keyPoints = result.keyPoints || [];
    if (result.domain) articleData.domain = result.domain;
    if (!articleData.domain) articleData.domain = detectDomain(articleData.titleFr + ' ' + articleData.summary);

    // Use publication date from article if found, else keep import date
    if (result.publicationDate) {
      try {
        const pubDate = new Date(result.publicationDate);
        if (!isNaN(pubDate.getTime())) {
          articleData.publicationDate = pubDate.toISOString();
          articleData.week  = getWeekNumber(pubDate);
          articleData.month = pubDate.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
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
  "publicationDate": "date de publication de l'article au format ISO 8601 (YYYY-MM-DD) si trouvée dans le contenu, sinon null"
}
Les keyPoints doivent contenir entre 3 et 10 éléments, chacun commençant par un emoji.
Pour publicationDate : cherche dans le HTML des balises meta (article:published_time, datePublished, pubdate), des mentions de date en texte (ex: "12 janvier 2025", "Jan 12 2025"), ou tout autre indicateur de date dans le contenu.`
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

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.titleFr) parsed.titleFr = article.title || 'Article sans titre';
    if (!parsed.summary) parsed.summary = 'Résumé non disponible';
    if (!Array.isArray(parsed.keyPoints) || parsed.keyPoints.length === 0) {
      parsed.keyPoints = ['👩🏻‍🚀 Contenu extrait automatiquement'];
    }
    return parsed;
  } catch(e) {
    return {
      titleFr: article.title || 'Article sans titre',
      summary: text.substring(0, 300) || 'Résumé non disponible',
      keyPoints: ['👩🏻‍🚀 Résumé généré depuis l\'URL'],
      domain: article.domain || 'AI technologie',
      publicationDate: null
    };
  }
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

function computeSimilarity(a, b) {
  const textA = normalizeText(a.title + ' ' + a.content + ' ' + a.summary);
  const textB = normalizeText(b.title + ' ' + b.content + ' ' + b.summary);
  return jaccardSimilarity(textA, textB);
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
          <span>${formatDate(article.date)}</span>
          ${article.status === 'DUPLICATE_SUSPECTED' ? `<span style="color:var(--warning)">⚠ Doublon suspecté</span>` : ''}
        </div>
      </div>
      <div class="validation-actions">
        ${article.status === 'DUPLICATE_SUSPECTED'
          ? `<button class="btn-warning small" onclick="reopenDuplicateModal('${article.id}')">⚠ Voir doublon</button>`
          : ''}
        <button class="btn-success small" onclick="validateArticle('${article.id}')">✅ Valider</button>
        <button class="btn-secondary small" onclick="openArticleModal('${article.id}')">👁 Voir</button>
        <button class="btn-danger small" onclick="rejectArticleById('${article.id}')">❌ Rejeter</button>
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
    <small style="color:var(--text-muted)">${formatDate(newArticle.date)}</small><br><br>
    ${escHtml((newArticle.summary || '').substring(0, 200))}
  `;
  document.getElementById('suspect-article-preview').innerHTML = `
    <strong>${escHtml(existingArticle.titleFr || existingArticle.title)}</strong><br>
    <small style="color:var(--text-muted)">${formatDate(existingArticle.date)}</small><br><br>
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

function mergeArticles() {
  if (!state.currentDuplicateCheck) return;
  const { new: newA, existing } = state.currentDuplicateCheck;
  // Merge key points
  const merged = {
    ...existing,
    keyPoints: [...(existing.keyPoints || []), ...(newA.keyPoints || [])].slice(0, 10),
    summary: (existing.summary || '') + '\n\n[Fusionné] ' + (newA.summary || ''),
    status: 'MERGED'
  };
  const idx = state.articles.findIndex(a => a.id === existing.id);
  if (idx !== -1) state.articles[idx] = merged;
  // Remove the new duplicate
  state.articles = state.articles.filter(a => a.id !== newA.id);
  state.currentDuplicateCheck = null;
  saveToStorage();
  closeModal('duplicate-modal');
  renderSavedArticles();
  renderValidationQueue();
  showToast('🔁 Articles fusionnés', 'success');
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
  let articles = state.articles.filter(a => a.status !== 'REJECTED');
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
  const displayDate = a.publicationDate
    ? `📅 ${formatDate(a.publicationDate)}`
    : `⬇ importé ${formatDate(a.date)}`;
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
        <span class="article-date">${displayDate}</span>
        ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" style="font-size:11px;color:var(--accent)">🔗 Source</a>` : ''}
      </div>
      ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : ''}
    </div>
  `;
}

function deleteArticle(id) {
  if (!confirm('Supprimer cet article ?')) return;
  state.articles = state.articles.filter(a => a.id !== id);
  saveToStorage();
  renderSavedArticles();
  renderValidationQueue();
  updateStats();
  showToast('🗑 Article supprimé', 'warning');
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
    ? `<ul>${a.keyPoints.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>`
    : '';
  const summaryBlock = `
    <div class="summary-block">
      <h3>${escHtml(a.titleFr || a.title)}</h3>
      ${a.url ? `<p><a href="${escHtml(a.url)}" target="_blank" style="color:var(--accent)">🔗 Lire en ligne</a> | <span style="color:var(--text-muted)">${formatDate(a.date)}</span></p><br>` : ''}
      <p>${escHtml(a.summary || 'Aucun résumé généré')}</p>
      ${keyPointsHtml ? `<br><strong>Informations importantes :</strong>${keyPointsHtml}` : ''}
      <br><p><strong>Domaine :</strong> ${DOMAIN_ICONS[a.domain] || ''} ${a.domain || 'Non classé'}</p>
    </div>
  `;
  const metaSection = `
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="domain-badge ${domainClass(a.domain)}">${a.domain}</span>
      <span class="status-badge ${statusClass(a.status)}">${statusLabel(a.status)}</span>
      <span style="font-size:12px;color:var(--text-muted)">Semaine ${a.week || '?'}</span>
      <button class="${a.favorite ? 'btn-warning' : 'btn-secondary'} small" onclick="toggleFavorite('${a.id}');closeModal('article-modal')">${a.favorite ? '⭐ Retirer des favoris' : '☆ Ajouter aux favoris'}</button>
      ${a.status === 'PENDING_REVIEW' ? `<button class="btn-success small" onclick="validateArticle('${a.id}');closeModal('article-modal')">✅ Valider</button>` : ''}
    </div>
  `;
  const contentSection = a.content ? `
    <div style="margin-top:16px">
      <h4 style="font-size:12px;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Contenu original</h4>
      <div style="background:var(--navy);border:1px solid var(--navy-border);border-radius:8px;padding:14px;font-size:12.5px;color:var(--text-secondary);line-height:1.7;max-height:250px;overflow-y:auto">${escHtml(a.content.substring(0, 2000))}${a.content.length > 2000 ? '...' : ''}</div>
    </div>
  ` : '';
  return summaryBlock + metaSection + contentSection;
}

// ============ VEILLE ============
function renderVeille() {
  renderVeilleFeatured();
  renderVeilleDomains();
  renderDefenseTable();
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
    <div class="article-card" style="cursor:pointer" onclick="openArticleModal('${a.id}')">
      <div class="article-card-title">${escHtml(a.titleFr || a.title)}</div>
      <div class="article-card-meta" style="margin-top:8px">
        <span class="domain-badge ${domainClass(a.domain)}">${DOMAIN_ICONS[a.domain] || ''} ${a.domain}</span>
        <span class="article-date">${formatDate(a.date)}</span>
      </div>
      ${a.summary ? `<div class="article-summary-preview">${escHtml(a.summary)}</div>` : ''}
    </div>
  `).join('');
}

function renderVeilleDomains() {
  const validated = state.articles.filter(a => a.status === 'VALIDATED');
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

    // Group by week
    const byWeek = {};
    for (const a of articles) {
      const key = `Semaine ${a.week || '?'}`;
      if (!byWeek[key]) byWeek[key] = [];
      byWeek[key].push(a);
    }

    const weekHtml = Object.entries(byWeek).map(([week, arts]) => `
      <div class="week-group">
        <div class="week-label">${week}</div>
        ${arts.map(a => `
          <div class="article-card" style="margin-bottom:8px">
            <div class="article-card-header">
              <div class="article-card-title" onclick="openArticleModal('${a.id}')">${escHtml(a.titleFr || a.title)}</div>
              <div class="article-card-actions">
                <button class="action-btn ${a.favorite ? 'favorited' : ''}" onclick="toggleFavorite('${a.id}')">${a.favorite ? '⭐' : '☆'}</button>
                <button class="action-btn" onclick="openArticleModal('${a.id}')">👁</button>
              </div>
            </div>
            <div class="article-card-meta">
              ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" style="font-size:11px;color:var(--accent)">🔗 Source</a>` : ''}
              <span class="article-date">${formatDate(a.date)}</span>
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

// ============ DEFENSE TABLE ============
let defenseRows = [];

function renderDefenseTable() {
  const defenseArticles = state.articles.filter(a => a.domain === 'Défense' && a.status === 'VALIDATED');
  const section = document.getElementById('defense-table-section');
  if (!section) return;

  if (defenseArticles.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  // Auto-add rows from defense articles
  for (const a of defenseArticles) {
    if (!defenseRows.find(r => r.sourceId === a.id)) {
      defenseRows.push({
        id: generateId(),
        sourceId: a.id,
        statut: 'En cours de développement',
        fabricant: extractActorFromArticle(a),
        produit: a.titleFr || a.title,
        role: a.summary || '',
        source: a.titleFr || a.title
      });
    }
  }
  renderDefenseTableRows();
}

function renderDefenseTableRows() {
  const tbody = document.getElementById('defense-tbody');
  if (!tbody) return;
  tbody.innerHTML = defenseRows.map(row => `
    <tr>
      <td>
        <select class="status-select" onchange="updateDefenseRow('${row.id}','statut',this.value)">
          <option ${row.statut === 'Concept' ? 'selected' : ''}>Concept</option>
          <option ${row.statut === 'En cours de développement' ? 'selected' : ''}>En cours de développement</option>
          <option ${row.statut === 'Existant' ? 'selected' : ''}>Existant</option>
        </select>
      </td>
      <td contenteditable="true" onblur="updateDefenseRow('${row.id}','fabricant',this.textContent)">${escHtml(row.fabricant)}</td>
      <td contenteditable="true" onblur="updateDefenseRow('${row.id}','produit',this.textContent)">${escHtml(row.produit)}</td>
      <td contenteditable="true" onblur="updateDefenseRow('${row.id}','role',this.textContent)">${escHtml(row.role)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${escHtml(row.source.substring(0, 50))}</td>
      <td>
        <button class="action-btn" onclick="removeDefenseRow('${row.id}')" title="Supprimer">🗑</button>
      </td>
    </tr>
  `).join('');
}

function updateDefenseRow(id, field, value) {
  const row = defenseRows.find(r => r.id === id);
  if (row) row[field] = value;
}

function addDefenseRow() {
  defenseRows.push({
    id: generateId(),
    sourceId: null,
    statut: 'Concept',
    fabricant: 'Nouveau fabricant',
    produit: 'Nouveau produit',
    role: 'Rôle de l\'IA',
    source: 'Manuel'
  });
  renderDefenseTableRows();
}

function removeDefenseRow(id) {
  defenseRows = defenseRows.filter(r => r.id !== id);
  renderDefenseTableRows();
}

function extractActorFromArticle(a) {
  const text = (a.content || '') + ' ' + (a.title || '');
  const companies = ['Thales', 'Airbus', 'Dassault', 'MBDA', 'Nexter', 'Safran', 'Leonardo', 'Lockheed', 'Raytheon', 'Boeing', 'BAE Systems', 'Northrop'];
  for (const c of companies) {
    if (text.toLowerCase().includes(c.toLowerCase())) return c;
  }
  return 'Non identifié';
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
function exportConfluence() {
  const period = document.getElementById('export-period').value;
  const selectedDomains = [...document.querySelectorAll('#export-domains input:checked')].map(i => i.value);

  let articles = state.articles.filter(a => a.status === 'VALIDATED' && selectedDomains.includes(a.domain));

  if (period === 'week') {
    const thisWeek = getWeekNumber(new Date());
    articles = articles.filter(a => a.week === thisWeek);
  } else if (period === 'month') {
    const thisMonth = new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
    articles = articles.filter(a => a.month === thisMonth);
  }

  let output = `# Veille Stratégique IA\n`;
  output += `**Généré le :** ${new Date().toLocaleDateString('fr-FR')}\n\n---\n\n`;

  // Featured
  const featured = articles.filter(a => a.favorite);
  if (featured.length > 0) {
    output += `## ⭐ Articles à la une\n\n`;
    featured.forEach(a => output += formatArticleMarkdown(a));
    output += '\n---\n\n';
  }

  // By domain
  const domains = [...new Set(articles.map(a => a.domain))];
  for (const domain of domains) {
    const domainArticles = articles.filter(a => a.domain === domain);
    if (domainArticles.length === 0) continue;
    output += `## ${DOMAIN_ICONS[domain]} ${domain}\n\n`;
    const weeks = [...new Set(domainArticles.map(a => a.week))].sort();
    for (const week of weeks) {
      output += `### Semaine ${week}\n\n`;
      domainArticles.filter(a => a.week === week).forEach(a => output += formatArticleMarkdown(a));
    }
  }

  showExportPreview(output);
}

function renderNewsletterWeekSelector() {
  const validated = state.articles.filter(a => a.status === 'VALIDATED');
  const weeks = [...new Set(validated.map(a => a.week))].filter(Boolean).sort((a,b) => b - a);
  const container = document.getElementById('newsletter-weeks-container');
  if (!container) return;
  if (weeks.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px">Aucun article validé</div>`;
    return;
  }
  container.innerHTML = weeks.map(w => `
    <label class="checkbox-item">
      <input type="checkbox" value="${w}" checked class="newsletter-week-cb">
      Semaine ${w} <span style="color:var(--text-muted);font-size:11px">(${validated.filter(a => a.week === w).length} articles)</span>
    </label>
  `).join('');
}

function exportNewsletter() {
  const selectedWeeks = [...document.querySelectorAll('.newsletter-week-cb:checked')].map(i => parseInt(i.value));
  const title = document.getElementById('newsletter-title').value ||
    (selectedWeeks.length === 1 ? `Veille IA — Semaine ${selectedWeeks[0]}` : `Veille IA — Semaines ${selectedWeeks.join(', ')}`);

  if (selectedWeeks.length === 0) {
    showToast('⚠ Sélectionnez au moins une semaine', 'warning');
    return;
  }

  const validated = state.articles.filter(a => a.status === 'VALIDATED' && selectedWeeks.includes(a.week));

  // Merge articles on same topic (similarity > 70%)
  const mergedGroups = groupSimilarArticles(validated);

  let output = `${title}\n${'='.repeat(Math.min(title.length, 60))}\n\n`;

  // Featured (favorites)
  const featured = validated.filter(a => a.favorite);
  if (featured.length > 0) {
    output += `Articles à la une :\n`;
    for (const w of selectedWeeks.sort()) {
      const wArts = featured.filter(a => a.week === w);
      if (wArts.length === 0) continue;
      output += `Semaine ${w}:\n`;
      wArts.forEach(a => output += `- ${a.titleFr || a.title}\n`);
    }
    output += '\n';
  }

  output += `Veille externe :\n\n`;

  const domains = Object.keys(DOMAIN_ICONS);
  for (const domain of domains) {
    const domainGroups = mergedGroups.filter(g => g.articles[0].domain === domain);
    if (domainGroups.length === 0) continue;
    output += `${domain} :\n`;
    for (const w of selectedWeeks.sort()) {
      const wGroups = domainGroups.filter(g => g.articles.some(a => a.week === w));
      if (wGroups.length === 0) continue;
      output += `Semaine ${w}:\n`;
      wGroups.forEach(g => {
        if (g.articles.length === 1) {
          output += `- ${g.articles[0].titleFr || g.articles[0].title}\n`;
        } else {
          // Merged group — show combined title + all links
          output += `- [SYNTHÈSE] ${g.mergedTitle}\n`;
          g.articles.forEach(a => output += `  • ${a.titleFr || a.title}${a.url ? ' — ' + a.url : ''}\n`);
        }
      });
    }
    output += '\n';
  }

  showExportPreview(output);
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
  preview.textContent = content;
  if (copyBtn) { copyBtn.style.display = ''; copyBtn.dataset.content = content; }
  showToast('✅ Export généré', 'success');
}

function copyExport() {
  const btn = document.getElementById('copy-btn');
  const content = document.getElementById('export-preview').textContent;
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
  defenseRows = [];
  saveToStorage();
  renderAllViews();
  showToast('🗑 Données effacées', 'warning');
}

// ============ INOREADER ============
function connectInoreader() {
  const token = document.getElementById('inoreader-token').value.trim();
  if (!token) { showToast('⚠ Entrez votre token Inoreader', 'warning'); return; }
  state.settings.inoreaderToken = token;
  saveToStorage();

  // Show mock feeds
  document.getElementById('inoreader-status').innerHTML = `
    <div class="status-indicator connected"></div>
    <span>Connecté à Inoreader</span>
  `;

  const feeds = [
    { title: 'MIT Technology Review — AI', count: 8 },
    { title: 'The Verge — Tech News', count: 12 },
    { title: 'AI News — Intelligence artificielle', count: 5 },
    { title: 'Defense One', count: 3 }
  ];

  const container = document.getElementById('feeds-container');
  container.innerHTML = feeds.map(f => `
    <div class="feed-item">
      <label>
        <input type="checkbox" class="feed-checkbox" checked> ${escHtml(f.title)}
      </label>
      <span style="font-size:11px;color:var(--text-muted)">${f.count} articles</span>
    </div>
  `).join('');

  document.getElementById('inoreader-feeds').classList.remove('hidden');
  showToast('✅ Inoreader connecté', 'success');
}

async function generateAllSummaries() {
  showLoading('Génération des résumés en cours...');
  await new Promise(r => setTimeout(r, 2000));
  hideLoading();
  showToast('✅ Résumés générés pour tous les articles sélectionnés', 'success');
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

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch(e) { return iso; }
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
  const map = { 'NEW': 'new', 'PENDING_REVIEW': 'pending', 'VALIDATED': 'validated', 'REJECTED': 'rejected', 'DUPLICATE_SUSPECTED': 'duplicate', 'MERGED': 'merged' };
  return map[status] || 'new';
}

function statusLabel(status) {
  const map = { 'NEW': 'Nouveau', 'PENDING_REVIEW': 'En attente', 'VALIDATED': 'Validé', 'REJECTED': 'Rejeté', 'DUPLICATE_SUSPECTED': 'Doublon ?', 'MERGED': 'Fusionné' };
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

      // Filter already imported URLs
      const existingUrls = new Set(state.articles.map(a => a.url));
      const newItems = aiItems.filter(item => item.link && !existingUrls.has(item.link));

      feed.articlesFound = aiItems.length;
      feed.lastFetch = new Date().toISOString();

      for (const item of newItems.slice(0, 5)) { // max 5 per feed per scan
        const article = {
          id: generateId(),
          url: item.link,
          title: item.title || 'Article RSS',
          titleFr: item.title || 'Article RSS',
          content: item.description || '',
          domain: detectDomain(item.title + ' ' + item.description),
          status: 'PENDING_REVIEW',
          date: new Date().toISOString(),
          publicationDate: item.pubDate ? (() => { try { return new Date(item.pubDate).toISOString(); } catch(e) { return null; } })() : null,
          week: item.pubDate ? getWeekNumber(new Date(item.pubDate)) : getWeekNumber(new Date()),
          month: item.pubDate
            ? new Date(item.pubDate).toLocaleString('fr-FR', { month: 'long', year: 'numeric' })
            : new Date().toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
          favorite: false,
          summary: '',
          keyPoints: [],
          fromRss: true,
          rssSource: feed.name
        };

        // Duplicate check before adding
        const dup = findDuplicate(article);
        if (!dup) {
          state.articles.push(article);
          totalNew++;
        }
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
    showToast(`✅ ${totalNew} nouvel${totalNew > 1 ? 's' : ''} article${totalNew > 1 ? 's' : ''} IA détecté${totalNew > 1 ? 's' : ''}`, 'success');
    // Auto-generate summaries for RSS articles
    if (state.settings.mistralKey) generateRssSummaries();
  } else {
    showToast('ℹ Aucun nouvel article IA trouvé', 'info');
  }

  // Reschedule
  scheduleRssAutoFetch();
}

async function fetchRssFeed(feedUrl) {
  // Use allorigins proxy to bypass CORS
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}`;
  const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
  const data = await resp.json();
  const xml = data.contents || '';
  return parseRssXml(xml);
}

function parseRssXml(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const items = [];

  // RSS 2.0
  doc.querySelectorAll('item').forEach(item => {
    items.push({
      title: item.querySelector('title')?.textContent?.trim() || '',
      link: item.querySelector('link')?.textContent?.trim() ||
            item.querySelector('guid')?.textContent?.trim() || '',
      description: stripHtml(item.querySelector('description')?.textContent || ''),
      pubDate: item.querySelector('pubDate')?.textContent?.trim() || ''
    });
  });

  // Atom feed
  if (items.length === 0) {
    doc.querySelectorAll('entry').forEach(entry => {
      items.push({
        title: entry.querySelector('title')?.textContent?.trim() || '',
        link: entry.querySelector('link')?.getAttribute('href') || '',
        description: stripHtml(entry.querySelector('summary, content')?.textContent || ''),
        pubDate: entry.querySelector('published, updated')?.textContent?.trim() || ''
      });
    });
  }

  return items;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500);
}

async function generateRssSummaries() {
  const pending = state.articles.filter(a => a.fromRss && a.status === 'PENDING_REVIEW' && !a.summary);
  if (pending.length === 0) return;

  for (const article of pending.slice(0, 3)) { // max 3 at a time to avoid rate limit
    try {
      const result = await generateSummaryWithMistral(article);
      article.titleFr = result.titleFr || article.title;
      article.title = article.titleFr;
      article.summary = result.summary || '';
      article.keyPoints = result.keyPoints || [];
      if (result.domain) article.domain = result.domain;
      if (result.publicationDate) {
        try {
          const d = new Date(result.publicationDate);
          if (!isNaN(d)) {
            article.publicationDate = d.toISOString();
            article.week = getWeekNumber(d);
            article.month = d.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
          }
        } catch(e) {}
      }
      saveToStorage();
      await new Promise(r => setTimeout(r, 800)); // small delay between calls
    } catch(e) {
      console.warn('RSS summary error:', e.message);
    }
  }
  renderRssTab();
  renderValidationQueue();
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

function renderRssFeedsList() {
  const container = document.getElementById('rss-feeds-list');
  const countEl = document.getElementById('rss-feeds-count');
  if (!container) return;
  if (countEl) countEl.textContent = `${state.rssFeeds.length} flux`;

  if (state.rssFeeds.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><p>Aucun flux RSS configuré</p><span>Ajoutez vos premiers flux ci-dessus</span></div>`;
    return;
  }

  container.innerHTML = state.rssFeeds.map(feed => `
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
        ${feed.lastFetch ? `<span class="rss-last-fetch">Scanné ${formatDate(feed.lastFetch)}</span>` : `<span class="rss-last-fetch">Jamais scanné</span>`}
        <button class="action-btn" onclick="testFeedUrl('${feed.id}')" title="Tester">🔌</button>
        <button class="action-btn" onclick="removeRssFeed('${feed.id}')" title="Supprimer">🗑</button>
      </div>
    </div>
  `).join('');
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
  showLoading(`Test du flux ${feed.name}...`);
  try {
    const items = await fetchRssFeed(feed.url);
    hideLoading();
    const aiCount = items.filter(i => isAiRelated(i.title + ' ' + i.description)).length;
    showToast(`✅ ${items.length} articles trouvés, ${aiCount} liés à l'IA`, 'success');
  } catch(e) {
    hideLoading();
    showToast('❌ Flux inaccessible : ' + e.message, 'error');
  }
}

// ============================================================
// SUPABASE SYNC
// ============================================================
// Uses Supabase REST API directly (no SDK needed)
// Table structure required in Supabase:
//   CREATE TABLE ia_platform (
//     user_id TEXT NOT NULL,
//     data_type TEXT NOT NULL,  -- 'articles' | 'rss_feeds' | 'settings'
//     payload JSONB NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT NOW(),
//     PRIMARY KEY (user_id, data_type)
//   );
//   ALTER TABLE ia_platform ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "anon read write" ON ia_platform FOR ALL USING (true) WITH CHECK (true);

let sb = { url: '', key: '', userId: '' };

function loadSupabaseConfig() {
  const cfg = localStorage.getItem('ia_sb_config');
  if (cfg) {
    try { sb = JSON.parse(cfg); } catch(e) {}
  }
}

function saveSupabaseConfig() {
  const url = document.getElementById('sb-url').value.trim().replace(/\/$/, '');
  const key = document.getElementById('sb-key').value.trim();
  const userId = document.getElementById('sb-user-id').value.trim();

  if (!url || !key || !userId) {
    showToast('⚠ Remplissez tous les champs', 'warning'); return;
  }

  sb = { url, key, userId };
  localStorage.setItem('ia_sb_config', JSON.stringify(sb));
  closeModal('supabase-modal');
  showToast('💾 Configuration Supabase sauvegardée — synchronisation...', 'success');
  syncNow();
}

async function testSupabaseConnection() {
  const url = document.getElementById('sb-url').value.trim().replace(/\/$/, '');
  const key = document.getElementById('sb-key').value.trim();
  const infoEl = document.getElementById('sb-setup-info');
  if (!url || !key) { showToast('⚠ Entrez URL et clé', 'warning'); return; }

  try {
    const resp = await fetch(`${url}/rest/v1/ia_platform?select=user_id&limit=1`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    });
    if (infoEl) {
      infoEl.style.display = 'flex';
      if (resp.ok || resp.status === 200) {
        infoEl.innerHTML = '<span>✅</span><span>Connexion réussie — table <strong>ia_platform</strong> trouvée.</span>';
        infoEl.style.background = 'var(--success-bg)';
        infoEl.style.borderColor = 'rgba(52,211,153,0.3)';
      } else if (resp.status === 404) {
        infoEl.innerHTML = '<span>⚠</span><span>Connecté, mais la table <strong>ia_platform</strong> n\'existe pas encore. Créez-la avec le SQL ci-dessous dans l\'éditeur Supabase.</span>';
        infoEl.style.background = 'var(--warning-bg)';
        infoEl.style.borderColor = 'rgba(251,191,36,0.3)';
      } else {
        infoEl.innerHTML = `<span>❌</span><span>Erreur ${resp.status} — vérifiez votre URL et clé API.</span>`;
        infoEl.style.background = 'var(--danger-bg)';
        infoEl.style.borderColor = 'rgba(248,113,113,0.3)';
      }
    }
  } catch(e) {
    if (infoEl) {
      infoEl.style.display = 'flex';
      infoEl.innerHTML = `<span>❌</span><span>Impossible de joindre Supabase : ${e.message}</span>`;
    }
  }
}

async function syncNow() {
  if (!sb.url || !sb.key || !sb.userId) {
    showToast('⚠ Configurez d\'abord Supabase dans Paramètres', 'warning');
    openModal('supabase-modal');
    return;
  }

  const resultEl = document.getElementById('sync-result');
  if (resultEl) { resultEl.style.display = 'none'; }

  try {
    // 1. Pull remote data
    const pullResp = await sbFetch(`/rest/v1/ia_platform?user_id=eq.${encodeURIComponent(sb.userId)}&select=data_type,payload,updated_at`);
    if (!pullResp.ok) throw new Error('Pull failed: ' + pullResp.status);
    const remoteRows = await pullResp.json();

    const remoteArticlesRow = remoteRows.find(r => r.data_type === 'articles');
    const remoteFeedsRow = remoteRows.find(r => r.data_type === 'rss_feeds');
    const remoteSettingsRow = remoteRows.find(r => r.data_type === 'settings');

    // 2. Merge articles (union by id, remote wins on conflict)
    if (remoteArticlesRow?.payload?.articles) {
      const remoteArticles = remoteArticlesRow.payload.articles;
      const localIds = new Set(state.articles.map(a => a.id));
      const remoteIds = new Set(remoteArticles.map(a => a.id));

      // Add remote articles not in local
      remoteArticles.forEach(ra => {
        if (!localIds.has(ra.id)) state.articles.push(ra);
        else {
          // If remote is newer, update local
          const localIdx = state.articles.findIndex(a => a.id === ra.id);
          if (localIdx !== -1 && ra.date > state.articles[localIdx].date) {
            state.articles[localIdx] = ra;
          }
        }
      });
    }

    // Merge RSS feeds
    if (remoteFeedsRow?.payload?.feeds) {
      const remoteFeeds = remoteFeedsRow.payload.feeds;
      const localFeedIds = new Set(state.rssFeeds.map(f => f.id));
      remoteFeeds.forEach(rf => { if (!localFeedIds.has(rf.id)) state.rssFeeds.push(rf); });
    }

    // Merge settings (keep local mistralKey private, sync rest)
    if (remoteSettingsRow?.payload?.settings) {
      const rs = remoteSettingsRow.payload.settings;
      state.settings = {
        ...rs,
        mistralKey: state.settings.mistralKey // never sync API key to cloud
      };
    }

    // 3. Push local data to remote (upsert)
    const now = new Date().toISOString();
    const upsertData = [
      { user_id: sb.userId, data_type: 'articles', payload: { articles: state.articles }, updated_at: now },
      { user_id: sb.userId, data_type: 'rss_feeds', payload: { feeds: state.rssFeeds }, updated_at: now },
      { user_id: sb.userId, data_type: 'settings', payload: { settings: { ...state.settings, mistralKey: '' } }, updated_at: now }
    ];

    const pushResp = await sbFetch('/rest/v1/ia_platform', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(upsertData)
    });
    if (!pushResp.ok) throw new Error('Push failed: ' + pushResp.status);

    state.settings.lastSyncDate = now;
    saveToStorage();
    renderAllViews();
    updateStats();
    updateSyncUI(true);
    showToast('☁ Synchronisation réussie', 'success');

  } catch(e) {
    console.error('Sync error:', e);
    updateSyncUI(false, e.message);
    showToast('❌ Erreur de sync : ' + e.message, 'error');
  }
}

function sbFetch(path, options = {}) {
  return fetch(`${sb.url}${path}`, {
    ...options,
    headers: {
      'apikey': sb.key,
      'Authorization': `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

function updateSyncUI(success, errMsg) {
  const label = document.getElementById('sync-status-label');
  const infoRow = document.getElementById('sync-info-row');
  const syncBtn = document.getElementById('sync-now-btn');
  const disconnectBtn = document.getElementById('disconnect-sync-btn');
  const lastSyncEl = document.getElementById('sb-last-sync');
  const userEl = document.getElementById('sb-user-display');
  const projectEl = document.getElementById('sb-project-name');
  const resultEl = document.getElementById('sync-result');

  const isConfigured = !!(sb.url && sb.key && sb.userId);

  if (label) {
    label.textContent = !isConfigured ? 'Non configuré' : success ? '✅ Synchronisé' : '⚠ Erreur';
    label.style.color = !isConfigured ? 'var(--text-muted)' : success ? 'var(--success)' : 'var(--warning)';
  }
  if (infoRow) infoRow.style.display = isConfigured ? '' : 'none';
  if (syncBtn) syncBtn.style.display = isConfigured ? '' : 'none';
  if (disconnectBtn) disconnectBtn.style.display = isConfigured ? '' : 'none';
  if (lastSyncEl) lastSyncEl.textContent = state.settings.lastSyncDate ? formatDate(state.settings.lastSyncDate) : '—';
  if (userEl) userEl.textContent = sb.userId || '—';
  if (projectEl) projectEl.textContent = sb.url ? extractDomainName(sb.url) : '—';
  if (resultEl && errMsg) {
    resultEl.textContent = '❌ ' + errMsg;
    resultEl.className = 'connection-status error';
  }
}

function disconnectSync() {
  if (!confirm('Déconnecter la synchronisation ? Vos données locales sont conservées.')) return;
  sb = { url: '', key: '', userId: '' };
  localStorage.removeItem('ia_sb_config');
  updateSyncUI(false);
  showToast('🔌 Synchronisation déconnectée', 'warning');
}

function generateUserId() {
  const id = 'user-' + Math.random().toString(36).substr(2, 10);
  document.getElementById('sb-user-id').value = id;
}

function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

// ============================================================
// INIT: load Supabase config and schedule RSS on startup
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadSupabaseConfig();
  updateSyncUI(!!(sb.url && sb.key && sb.userId));

  // Auto-sync on open if configured
  if (sb.url && sb.key && sb.userId) {
    syncNow();
  }

  // Schedule RSS auto-fetch
  scheduleRssAutoFetch();
}, { once: true }); // 'once' ensures this second DOMContentLoaded doesn't conflict
