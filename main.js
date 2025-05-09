const { Plugin, Modal, Notice } = require('obsidian');

// =============================================================================
// Flashcard Plugin – v0.5 (sidebar ribbon icon + graded‑chooser)
// =============================================================================

class FlashcardPlugin extends Plugin {
  async onload() {
    // 1️⃣ ribbon icon in the left sidebar
    this.addRibbonIcon('book-open', 'Start Flashcards', () => this.startFlashcards());

    // 2️⃣ load persisted grades
    this.grades = (await this.loadData()) || {};

    // 3️⃣ command‑palette entry
    this.addCommand({ id: 'start-flashcards', name: 'Start Flashcards', callback: () => this.startFlashcards() });

    await this.injectStyles();
  }

  // ---------------------------------------------------------------------------
  async injectStyles() {
    const id = 'flashcard-plugin-styles';
    if (document.getElementById(id)) return;
    const path = `.obsidian/plugins/${this.manifest.id}/styles.css`;
    const file = this.app.vault.getAbstractFileByPath(path);
    let css = '';
    if (file) try { css = await this.app.vault.read(file); } catch {/* ignore */ }
    const el = document.createElement('style'); el.id = id; el.textContent = css; document.head.appendChild(el);
  }

  // ---------------------------------------------------------------------------
  async startFlashcards() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return new Notice('No active file.');
    const txt = await this.app.vault.read(file);
    const cards = this.parseCards(txt);
    if (!cards.length) return new Notice('No flashcards found.');
    this.originalFlashcards = cards;
    const graded = cards.filter(c => this.grades[c.question]);
    graded.length ? new LaunchModal(this.app, cards, graded, this).open()
      : new FlashcardModal(this.app, cards, this).open();
  }

  parseCards(s) { const r = /^#Q\s*(.*?)::\s*(.*)$/gm, arr = []; let m; while ((m = r.exec(s))) arr.push({ question: m[1].trim(), answer: m[2].trim() }); return arr; }
}

// =============================================================================
// Launch chooser modal
// =============================================================================
class LaunchModal extends Modal {
  constructor(app, all, graded, plugin) { super(app); this.all = all; this.graded = graded; this.plugin = plugin; }
  onOpen() {
    this.contentEl.addClass('flashcard-modal');
    this.contentEl.createEl('h3', { text: 'Flashcards – choose session' });
    const row = this.contentEl.createEl('div', { cls: 'summary-container' });
    const g = row.createEl('button', { text: `Review graded (${this.graded.length})` });
    g.addClass('flashcard-show-btn');
    g.addClass('flashcard-graded-btn');
    g.onclick = () => { this.close(); new SummaryModal(this.app, this.graded, this.plugin).open(); };
    const a = row.createEl('button', { text: `Review all (${this.all.length})` });
    a.addClass('flashcard-show-btn');
    a.addClass('flashcard-all-btn');
    a.onclick = () => { this.close(); new FlashcardModal(this.app, this.all, this.plugin).open(); };
  }
  onClose() { this.contentEl.empty(); }
}

// =============================================================================
// Flashcard review modal
// =============================================================================
class FlashcardModal extends Modal {
  constructor(app, cards, plugin) { super(app); this.cards = cards; this.plugin = plugin; this.idx = 0; }
  onOpen() { this.contentEl.addClass('flashcard-modal'); this.render(); }

  // Helper function to render basic markdown formatting
  renderMarkdown(text) {
    // Convert markdown bold (**text**) to HTML bold (<strong>text</strong>)
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>'); // Also handle italic text
  }

  render() {
    this.contentEl.empty();
    const c = this.cards[this.idx];
    // Create question element with Markdown support
    const questionEl = this.contentEl.createEl('div', { cls: 'flashcard-question' });
    questionEl.innerHTML = this.renderMarkdown(c.question);
    const prev = this.plugin.grades[c.question];
    if (prev) {
      const gradeContainer = this.contentEl.createEl('div', { cls: 'grade-container' });
      gradeContainer.createEl('span', { text: 'Grade: ' });
      const gradeValue = gradeContainer.createEl('span', { text: prev, cls: 'flashcard-grade' });
      gradeValue.addClass(`flashcard-grade-${prev}`);
    }
    const show = this.contentEl.createEl('button', { text: 'Show Answer', cls: 'flashcard-show-btn' });
    show.onclick = () => {
      show.remove();
      // Create answer element with Markdown support
      const answerEl = this.contentEl.createEl('div', { cls: 'flashcard-answer' });
      answerEl.innerHTML = this.renderMarkdown(c.answer);
      const row = this.contentEl.createEl('div', { cls: 'flashcard-buttons' });
      ['again', 'hard', 'good', 'easy'].forEach(g => {
        const b = row.createEl('button', { text: g[0].toUpperCase() + g.slice(1) });
        b.addClass(`flashcard-btn-${g}`);
        b.onclick = () => this.gradeAndNext(g);
      });
    };
  }
  async gradeAndNext(g) { this.plugin.grades[this.cards[this.idx].question] = g; await this.plugin.saveData(this.plugin.grades); this.idx++; if (this.idx < this.cards.length) { this.render(); } else { this.close(); new SummaryModal(this.app, this.plugin.originalFlashcards, this.plugin).open(); } }
  onClose() { this.contentEl.empty(); }
}

// =============================================================================
// Summary modal
// =============================================================================
class SummaryModal extends Modal {
  constructor(app, cards, plugin) { super(app); this.cards = cards; this.plugin = plugin; }
  onOpen() {
    this.contentEl.addClass('flashcard-modal');
    this.contentEl.createEl('h3', { text: 'Review Summary' });
    const buckets = { again: [], hard: [], good: [], easy: [] };
    this.cards.forEach(c => { const g = this.plugin.grades[c.question]; if (g && buckets[g]) buckets[g].push(c); });
    const row = this.contentEl.createEl('div', { cls: 'summary-container' });
    Object.entries(buckets).forEach(([k, v]) => { if (!v.length) return; const b = row.createEl('button', { text: `Review ${k} (${v.length})` }); b.addClass(`flashcard-btn-${k}`); b.onclick = () => { this.close(); new FlashcardModal(this.app, v, this.plugin).open(); }; });
    const ctrl = this.contentEl.createEl('div', { cls: 'summary-controls' });
    const reset = ctrl.createEl('button', { text: 'Reset Grades', cls: 'summary-reset-btn' }); reset.onclick = async () => { this.plugin.grades = {}; await this.plugin.saveData({}); new Notice('Grades reset'); this.close(); };
    const done = ctrl.createEl('button', { text: 'Done', cls: 'summary-done-btn' }); done.onclick = () => this.close();
    done.addClass('done-btn');

  }
  onClose() { this.contentEl.empty(); }
}

module.exports = FlashcardPlugin;
