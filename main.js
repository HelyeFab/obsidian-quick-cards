const { Plugin, Modal, Notice } = require('obsidian');

// =============================================================================
// Quick Cards Plugin – v0.5 (spaced repetition for Obsidian)
// =============================================================================

class QuickCardsPlugin extends Plugin {
  async onload() {
    // 1️⃣ ribbon icon in the left sidebar
    this.addRibbonIcon('hop', 'Start Flashcards', () => this.startFlashcards());

    // 2️⃣ load persisted card data
    this.cardData = (await this.loadData()) || { cards: {} };

    // Migrate old format if needed
    if (this.grades && !this.cardData.cards) {
      this.cardData = { cards: {} };
      Object.entries(this.grades).forEach(([question, grade]) => {
        this.cardData.cards[question] = {
          grade: grade,
          nextReview: Date.now(),
          interval: 0,
          easeFactor: 2.5,
          repetitions: 0
        };
      });
      this.grades = null;
    }

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

    // Ensure cardData.cards exists
    if (!this.cardData || !this.cardData.cards) {
      this.cardData = { cards: {} };
    }

    // Filter cards due for review (already seen at least once)
    const now = Date.now();
    const dueCards = cards.filter(c => {
      // Skip cards without questions (defensive check)
      if (!c || !c.question) return false;

      const cardData = this.cardData.cards[c.question];
      return cardData && cardData.nextReview <= now;
    });

    // Sort by how overdue they are (if both cards have data)
    dueCards.sort((a, b) => {
      const aData = this.cardData.cards[a.question];
      const bData = this.cardData.cards[b.question];
      // Make sure both cards have data before comparing
      if (!aData && !bData) return 0;
      if (!aData) return 1;  // Push cards without data to the end
      if (!bData) return -1; // Push cards without data to the end
      return (aData.nextReview - bData.nextReview);
    });

    // If there are due cards, show those, otherwise show all cards
    dueCards.length ? new LaunchModal(this.app, cards, dueCards, this).open()
      : new FlashcardModal(this.app, cards, this).open();
  }

  // Calculate the next review date based on grade
  calculateNextReview(cardData, grade) {
    let interval = 0;
    let easeFactor = cardData.easeFactor || 2.5;
    let repetitions = cardData.repetitions || 0;

    // Apply spaced repetition algorithm based on grade
    switch(grade) {
      case 'again':
        // Reset
        interval = 0;
        repetitions = 0;
        easeFactor = Math.max(1.3, easeFactor - 0.2);
        break;
      case 'hard':
        if (repetitions === 0) {
          interval = 1; // 1 day
        } else if (repetitions === 1) {
          interval = 3; // 3 days
        } else {
          interval = Math.max(1, Math.round(cardData.interval * 1.2));
        }
        easeFactor = Math.max(1.3, easeFactor - 0.15);
        repetitions++;
        break;
      case 'good':
        if (repetitions === 0) {
          interval = 1; // 1 day
        } else if (repetitions === 1) {
          interval = 3; // 3 days
        } else {
          interval = Math.round(cardData.interval * easeFactor);
        }
        repetitions++;
        break;
      case 'easy':
        if (repetitions === 0) {
          interval = 3; // 3 days
        } else if (repetitions === 1) {
          interval = 7; // 7 days
        } else {
          interval = Math.round(cardData.interval * easeFactor * 1.3);
        }
        easeFactor = easeFactor + 0.15;
        repetitions++;
        break;
    }

    // Calculate next review date
    const nextReview = Date.now() + (interval * 24 * 60 * 60 * 1000); // Convert days to milliseconds

    return {
      grade,
      interval,
      easeFactor,
      repetitions,
      nextReview
    };
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

    // Show "Review due" button if there are cards due for review
    if (this.graded.length) {
      const g = row.createEl('button', { text: `Review due (${this.graded.length})` });
      g.addClass('flashcard-show-btn');
      g.addClass('flashcard-graded-btn');
      g.onclick = () => { this.close(); new FlashcardModal(this.app, this.graded, this.plugin).open(); };
    }

    // Always show "Review all" button
    const a = row.createEl('button', { text: `Review all (${this.all.length})` });
    a.addClass('flashcard-show-btn');
    a.addClass('flashcard-all-btn');
    a.onclick = () => { this.close(); new FlashcardModal(this.app, this.all, this.plugin).open(); };

    // Add summary button
    const s = row.createEl('button', { text: 'Statistics' });
    s.addClass('flashcard-show-btn');
    s.addClass('flashcard-stats-btn');
    s.onclick = () => { this.close(); new SummaryModal(this.app, this.all, this.plugin).open(); };
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

    // Add progress indicator
    this.contentEl.createEl('div', {
      text: `Card ${this.idx + 1} of ${this.cards.length}`,
      cls: 'flashcard-progress'
    });

    // Create question element with Markdown support
    const questionEl = this.contentEl.createEl('div', { cls: 'flashcard-question' });
    questionEl.innerHTML = this.renderMarkdown(c.question);

    // Get card data if it exists
    const cardData = this.plugin.cardData.cards[c.question];
    if (cardData) {
      const gradeContainer = this.contentEl.createEl('div', { cls: 'grade-container' });
      gradeContainer.createEl('span', { text: 'Grade: ' });
      const gradeValue = gradeContainer.createEl('span', { text: cardData.grade, cls: 'flashcard-grade' });
      gradeValue.addClass(`flashcard-grade-${cardData.grade}`);

      // Show next review date if it's in the future
      if (cardData.nextReview > Date.now()) {
        const daysUntil = Math.ceil((cardData.nextReview - Date.now()) / (24 * 60 * 60 * 1000));
        const reviewInfo = this.contentEl.createEl('div', {
          text: `Next review in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`,
          cls: 'flashcard-next-review'
        });
      }
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
  async gradeAndNext(g) {
    // Get the current card's question
    const question = this.cards[this.idx].question;

    // Get existing card data or initialize new data
    const existingData = this.plugin.cardData.cards[question] || {
      interval: 0,
      easeFactor: 2.5,
      repetitions: 0,
      nextReview: Date.now()
    };

    // Apply spaced repetition algorithm
    const updatedData = this.plugin.calculateNextReview(existingData, g);

    // Update card data
    this.plugin.cardData.cards[question] = updatedData;

    // Save to storage
    await this.plugin.saveData(this.plugin.cardData);

    // Move to next card or finish
    this.idx++;
    if (this.idx < this.cards.length) {
      this.render();
    } else {
      this.close();
      new SummaryModal(this.app, this.plugin.originalFlashcards, this.plugin).open();
    }
  }
  onClose() { this.contentEl.empty(); }
}

// =============================================================================
// Summary modal
// =============================================================================
class SummaryModal extends Modal {
  constructor(app, cards, plugin) { super(app); this.cards = cards; this.plugin = plugin; }
  onOpen() {
    this.contentEl.addClass('flashcard-modal');

    // Add a centered title
    this.contentEl.createEl('h3', { text: 'Review Summary', cls: 'summary-title' });

    // Organize cards into buckets by grade
    const buckets = { again: [], hard: [], good: [], easy: [] };
    this.cards.forEach(c => {
      const cardData = this.plugin.cardData.cards[c.question];
      if (cardData && cardData.grade && buckets[cardData.grade]) {
        buckets[cardData.grade].push(c);
      }
    });

    // Statistics section with improved prominence
    const stats = this.contentEl.createEl('div', { cls: 'flashcard-stats' });

    // Calculate due cards
    const now = Date.now();
    const dueCount = Object.values(this.plugin.cardData.cards).filter(c => c.nextReview <= now).length;
    stats.createEl('div', { text: `Cards due for review: ${dueCount}` });

    // Add total cards count
    const totalCards = Object.keys(this.plugin.cardData.cards).length;
    if (totalCards > 0) {
      stats.createEl('div', { text: `Total cards reviewed: ${totalCards}` });
    }

    // Container for review buttons - only create if there are cards to review
    const row = this.contentEl.createEl('div', { cls: 'summary-container' });

    // Add buttons for each non-empty category
    let hasReviewButtons = false;
    Object.entries(buckets).forEach(([k, v]) => {
      if (!v.length) return;
      hasReviewButtons = true;
      const b = row.createEl('button', { text: `Review ${k} (${v.length})` });
      b.addClass(`flashcard-btn-${k}`);
      b.onclick = () => { this.close(); new FlashcardModal(this.app, v, this.plugin).open(); };
    });

    // If no review buttons were added, show a message
    if (!hasReviewButtons) {
      row.createEl('div', {
        text: 'No graded cards to review yet',
        cls: 'summary-no-cards'
      });
    }

    // Control buttons in a centered container
    const ctrl = this.contentEl.createEl('div', { cls: 'summary-controls' });

    // Reset button
    const reset = ctrl.createEl('button', {
      text: 'Reset All Data',
      cls: 'summary-reset-btn'
    });
    reset.onclick = async () => {
      // Add confirmation dialog
      if (totalCards > 0 && !confirm('Are you sure you want to reset all flashcard data?')) {
        return;
      }

      this.plugin.cardData = { cards: {} };
      await this.plugin.saveData(this.plugin.cardData);
      new Notice('All flashcard data reset');
      this.close();
    };

    const done = ctrl.createEl('button', { text: 'Done', cls: 'summary-done-btn' });
    done.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

module.exports = QuickCardsPlugin;
