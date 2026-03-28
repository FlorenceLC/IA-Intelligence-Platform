/* =========================
   STATE GLOBAL
========================= */

let articles = [];
let savedArticles = [];
let featuredArticles = [];
let validationQueue = [];

let settings = {
    duplicateThreshold: 85,
    sensitivity: "normal"
};

/* =========================
   NAVIGATION
========================= */

function showTab(tabId) {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.classList.remove("active");
    });
    document.getElementById(tabId).classList.add("active");
}

/* =========================
   UTILS
========================= */

// Simulation de scraping (à remplacer par backend)
function fetchArticleContent(url) {
    return {
        title: "Titre simulé",
        content: "Contenu simulé de l'article",
        date: new Date().toISOString()
    };
}

// Simulation résumé IA
function generateSummary(content) {
    return {
        title: "Résumé IA",
        summary: "Résumé généré automatiquement basé sur le contenu.",
        keyPoints: [
            "🔹 Point important 1",
            "🔹 Point important 2",
            "🔹 Point important 3"
        ],
        domain: "IA"
    };
}

// Similarité simple (placeholder)
function similarity(a, b) {
    return Math.random() * 100; // remplacer par embeddings
}

/* =========================
   PIPELINE ARTICLE
========================= */

document.getElementById("addArticleBtn").addEventListener("click", () => {
    const url = document.getElementById("articleUrl").value;

    if (!url) return;

    const articleData = fetchArticleContent(url);
    const summaryData = generateSummary(articleData.content);

    const newArticle = {
        id: Date.now(),
        url,
        title: articleData.title,
        summary: summaryData,
        date: articleData.date,
        status: "PENDING_REVIEW"
    };

    // Détection doublon
    const duplicate = findDuplicate(newArticle);

    if (duplicate) {
        showDuplicateModal(newArticle, duplicate);
    } else {
        validationQueue.push(newArticle);
        renderValidationQueue();
        renderSummary(newArticle);
    }
});

/* =========================
   DOUBLONS
========================= */

function findDuplicate(newArticle) {
    return articles.find(existing => {
        const score = similarity(newArticle.title, existing.title);

        return score > settings.duplicateThreshold;
    });
}

/* =========================
   MODALE DOUBLON
========================= */

function showDuplicateModal(newArticle, duplicate) {
    const modal = document.getElementById("duplicateModal");
    modal.classList.remove("hidden");

    document.getElementById("duplicateComparison").innerHTML = `
        <p><strong>Nouveau :</strong> ${newArticle.title}</p>
        <p><strong>Existant :</strong> ${duplicate.title}</p>
    `;

    document.getElementById("mergeBtn").onclick = () => {
        mergeArticles(newArticle, duplicate);
        closeModal();
    };

    document.getElementById("validateNewBtn").onclick = () => {
        validationQueue.push(newArticle);
        renderValidationQueue();
        closeModal();
    };

    document.getElementById("rejectDuplicateBtn").onclick = () => {
        closeModal();
    };
}

function closeModal() {
    document.getElementById("duplicateModal").classList.add("hidden");
}

/* =========================
   VALIDATION
========================= */

function renderValidationQueue() {
    const container = document.getElementById("validationQueue");
    container.innerHTML = "";

    validationQueue.forEach(article => {
        const div = document.createElement("div");
        div.className = "article";

        div.innerHTML = `
            <h4>${article.title}</h4>
            <button onclick="validateArticle(${article.id})">Valider</button>
        `;

        container.appendChild(div);
    });
}

function validateArticle(id) {
    const index = validationQueue.findIndex(a => a.id === id);

    if (index !== -1) {
        const article = validationQueue.splice(index, 1)[0];
        articles.push(article);

        renderSavedArticles();
        renderValidationQueue();
    }
}

/* =========================
   SAUVEGARDE / FAVORIS
========================= */

document.getElementById("saveBtn").addEventListener("click", () => {
    const article = validationQueue[0];

    if (!article) return;

    article.status = "VALIDATED";
    savedArticles.push(article);

    renderSavedArticles();
    addToFeatured(article);
});

function addToFeatured(article) {
    featuredArticles.push(article);
    renderFeaturedArticles();
}

/* =========================
   RENDUS UI
========================= */

function renderSummary(article) {
    document.getElementById("summaryContainer").innerHTML = `
        <h3>${article.summary.title}</h3>
        <p>${article.summary.summary}</p>
        <ul>
            ${article.summary.keyPoints.map(k => `<li>${k}</li>`).join("")}
        </ul>
        <p><strong>Domaine :</strong> ${article.summary.domain}</p>
    `;
}

function renderSavedArticles() {
    const container = document.getElementById("savedArticles");
    container.innerHTML = "";

    savedArticles.forEach(article => {
        container.innerHTML += `<div class="article">${article.title}</div>`;
    });
}

function renderFeaturedArticles() {
    const container = document.getElementById("featuredArticles");
    container.innerHTML = "";

    featuredArticles.forEach(article => {
        container.innerHTML += `<div class="article">${article.title}</div>`;
    });
}

/* =========================
   EXPORT (SIMPLIFIÉ)
========================= */

function exportToConfluence() {
    let exportText = "";

    savedArticles.forEach(article => {
        exportText += `
### ${article.title}

[Lire en ligne](${article.url}) | ${article.date}

${article.summary.summary}

**Informations importantes :**
${article.summary.keyPoints.map(p => `- ${p}`).join("\n")}

Domaine : ${article.summary.domain}

---
`;
    });

    console.log(exportText);
}

/* =========================
   TABLE IA
========================= */

document.getElementById("addRowBtn").addEventListener("click", () => {
    const table = document.querySelector("#aiTable tbody");

    const row = document.createElement("tr");

    row.innerHTML = `
        <td contenteditable>Concept</td>
        <td contenteditable>Fabricant</td>
        <td contenteditable>Produit</td>
        <td contenteditable>Rôle IA</td>
    `;

    table.appendChild(row);
});

/* =========================
   CHAT IA (SIMPLIFIÉ)
========================= */

document.getElementById("askBtn").addEventListener("click", () => {
    const query = document.getElementById("queryInput").value;

    const response = document.getElementById("chatResponse");

    response.innerHTML = `
        <p>🔎 Réponse simulée à : "${query}"</p>
    `;
});

/* =========================
   SETTINGS
========================= */

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
    settings.duplicateThreshold = document.getElementById("duplicateThreshold").value;
    settings.sensitivity = document.getElementById("sensitivity").value;

    alert("Paramètres sauvegardés !");
});

/* =========================
   INIT
========================= */

showTab("dashboard");
