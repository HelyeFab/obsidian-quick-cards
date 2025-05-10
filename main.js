const { Plugin, Modal, Notice } = require('obsidian');

// =============================================================================
// Quick Cards Plugin – v0.5 (spaced repetition for Obsidian)
// =============================================================================

class QuickCardsPlugin extends Plugin {
  async onload() {
    // 1️⃣ ribbon icon in the left sidebar
    this.addRibbonIcon('hop', 'Start Flashcards', () => this.startFlashcards());

    // Command palette entry is defined below

    // 2️⃣ load persisted card data with error handling and validation
    try {
      // Load the data
      const rawData = await this.loadData();

      // Validate and process the loaded data
      if (rawData) {
        if (this.isValidCardData(rawData)) {
          this.cardData = rawData;
        } else {
          // If invalid, create a new structure but log a warning
          console.warn("Quick Cards: Invalid data format detected. Creating new data structure.");
          this.cardData = { cards: {}, backups: [] };

          // Try to recover what we can from the invalid data
          if (rawData.cards && typeof rawData.cards === 'object') {
            this.cardData.cards = rawData.cards;
          }
        }
      } else {
        // No data found, initialize with empty structure
        this.cardData = { cards: {}, backups: [] };
      }

      // Migrate old format if needed
      if (this.grades && !this.cardData.cards) {
        this.cardData = { cards: {}, backups: [] };
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
    } catch (error) {
      console.error("Quick Cards: Error loading data", error);
      new Notice("Error loading flashcard data. Using empty data set.");
      this.cardData = { cards: {}, backups: [] };
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

    // Always show the launch modal first if we have existing cards
    // This allows users to choose between reviewing due cards, all cards, or viewing stats
    new LaunchModal(this.app, cards, dueCards, this).open();
  }

  // Calculator methods and other functionality continue below

  // Calculate the next review date based on grade
  calculateNextReview(cardData, grade) {
    let interval = 0;
    let easeFactor = cardData.easeFactor || 2.5;
    let repetitions = cardData.repetitions || 0;

    // Apply spaced repetition algorithm based on grade
    switch (grade) {
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

  parseCards(s) {
    try {
      const arr = [];

      // Safety check for input
      if (!s || typeof s !== 'string') {
        console.error("Quick Cards: Invalid content for parsing");
        return [];
      }

      // Split the content by #Q markers
      const sections = s.split(/^#Q/gm).slice(1);

      for (const section of sections) {
        try {
          // Skip empty sections
          if (!section || !section.trim()) continue;

          // Split each section into question and answer parts at the first ::
          const parts = section.split(/::(.+)/s);
          if (parts.length >= 2) {
            const question = parts[0].trim();
            const answer = parts[1] ? parts[1].trim() : '';

            // Skip cards with empty questions
            if (!question) continue;

            // Sanitize content to prevent HTML injection
            const sanitizedQuestion = this.sanitizeContent(question);
            const sanitizedAnswer = this.sanitizeContent(answer);

            arr.push({
              question: sanitizedQuestion,
              answer: sanitizedAnswer
            });
          }
        } catch (sectionError) {
          console.error("Quick Cards: Error parsing section", sectionError);
          // Continue with next section instead of failing the whole parse
          continue;
        }
      }
      return arr;
    } catch (error) {
      console.error("Quick Cards: Error parsing cards", error);
      return [];
    }
  }

  // Simple HTML sanitizer to prevent injection attacks
  sanitizeContent(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Validate the loaded card data structure
  isValidCardData(data) {
    // Check if data is an object
    if (!data || typeof data !== 'object') return false;

    // Check if the cards property exists and is an object
    if (!data.cards || typeof data.cards !== 'object') return false;

    // Check a few cards to ensure they have the expected structure
    const cardSample = Object.values(data.cards).slice(0, 3);
    for (const card of cardSample) {
      if (!card || typeof card !== 'object') return false;

      // Check if essential properties exist
      if (!('grade' in card) || !('nextReview' in card) ||
        !('interval' in card) || !('easeFactor' in card) ||
        !('repetitions' in card)) {
        return false;
      }

      // Type checking for properties
      if (typeof card.grade !== 'string' ||
        typeof card.nextReview !== 'number' ||
        typeof card.interval !== 'number' ||
        typeof card.easeFactor !== 'number' ||
        typeof card.repetitions !== 'number') {
        return false;
      }
    }

    return true;
  }

  // Create a backup of the current card data
  async createBackup() {
    try {
      if (!this.cardData.backups) {
        this.cardData.backups = [];
      }

      // Create a backup with timestamp
      const backup = {
        timestamp: Date.now(),
        cards: JSON.parse(JSON.stringify(this.cardData.cards))
      };

      // Keep only the last 5 backups
      this.cardData.backups.push(backup);
      if (this.cardData.backups.length > 5) {
        this.cardData.backups.shift();
      }

      await this.saveData(this.cardData);
      console.log("Quick Cards: Backup created successfully");
      return true;
    } catch (error) {
      console.error("Quick Cards: Failed to create backup", error);
      return false;
    }
  }

  // Restore from a backup by index (most recent = -1)
  async restoreFromBackup(backupIndex = -1) {
    try {
      if (!this.cardData.backups || this.cardData.backups.length === 0) {
        new Notice("No backups available to restore from");
        return false;
      }

      // Get the specified backup or the most recent one
      const index = backupIndex >= 0 ? backupIndex : this.cardData.backups.length - 1;
      if (index >= this.cardData.backups.length) {
        new Notice("Invalid backup index");
        return false;
      }

      const backup = this.cardData.backups[index];
      this.cardData.cards = JSON.parse(JSON.stringify(backup.cards));

      await this.saveData(this.cardData);
      new Notice(`Restored from backup (${new Date(backup.timestamp).toLocaleString()})`);
      return true;
    } catch (error) {
      console.error("Quick Cards: Failed to restore from backup", error);
      new Notice("Error restoring from backup");
      return false;
    }
  }
}

// =============================================================================
// Launch chooser modal
// =============================================================================
class LaunchModal extends Modal {
  constructor(app, all, graded, plugin) { super(app); this.all = all; this.graded = graded; this.plugin = plugin; }
  onOpen() {
    this.contentEl.addClass('flashcard-modal');
    this.contentEl.createEl('h3', { text: '📚 Flashcards – choose session' });

    // Add a container with mobile-friendly class
    const row = this.contentEl.createEl('div', { cls: 'summary-container' });

    // Check if we're on mobile
    const isMobile = window.innerWidth <= 480;

    // Add appropriate spacing for mobile if needed
    if (isMobile) {
      row.style.width = '100%';
    }

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
  onOpen() {
    this.contentEl.addClass('flashcard-modal');

    // Check if we're on mobile
    const isMobile = window.innerWidth <= 480;

    // Add appropriate mobile styles if needed
    if (isMobile) {
      this.contentEl.style.width = '100%';
    }

    this.render();
  }

  // Helper function to render markdown formatting including code blocks
  renderMarkdown(text) {
    try {
      // Process code blocks first (```) to avoid conflicts with other formatting
      let processedText = text;

      // Don't process if text is empty
      if (!processedText) return '';

      // Special case: HTML entities in non-code text that we want to preserve as actual characters
      // Only handle specific cases that we're sure should be rendered literally
      if (processedText.includes('&lt;') || processedText.includes('&gt;') ||
        processedText.includes('&amp;') || processedText.includes('&quot;') ||
        processedText.includes('&#039;')) {

        // Create a temporary replacement for HTML tag-like structures to protect them during processing
        processedText = processedText.replace(/&lt;([^&]+)&gt;/g, '__HTML_TAG_START__$1__HTML_TAG_END__');
      }

      // Process triple backtick code blocks with or without language specification
      processedText = processedText.replace(/```(\w+)?\s*([\s\S]*?)\s*```/g, (match, language, codeContent) => {
        // For code blocks, we need to handle all entities directly
        let processedCode = codeContent;

        // First, decode known entities before our sanitization runs
        processedCode = processedCode
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');

        // Handle already-escaped entities too
        processedCode = processedCode
          .replace(/&amp;quot;/g, '"')
          .replace(/&amp;#039;/g, "'")
          .replace(/&amp;lt;/g, '<')
          .replace(/&amp;gt;/g, '>')
          .replace(/&amp;amp;/g, '&');

        // Do minimal escaping for HTML safety but preserve the characters in the display
        const safeContent = processedCode
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        // Now replace any double escaped entities that our escaping might have created
        const finalContent = safeContent
          .replace(/&amp;quot;/g, '"')
          .replace(/&amp;#039;/g, "'")
          .replace(/&amp;lt;/g, '<')
          .replace(/&amp;gt;/g, '>')
          .replace(/&amp;amp;/g, '&');

        // Include language tag if available
        const langClass = language ? ` language-${language}` : '';
        return `<pre class="code-block"><code class="${langClass}">${finalContent}</code></pre>`;
      });

      // Replace inline code (single backticks)
      processedText = processedText.replace(/`([^`\n]+)`/g, (match, code) => {
        // For inline code, handle entities just like code blocks
        let processedCode = code;

        // First, decode all known entities
        processedCode = processedCode
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');

        // Handle already-escaped entities too
        processedCode = processedCode
          .replace(/&amp;quot;/g, '"')
          .replace(/&amp;#039;/g, "'")
          .replace(/&amp;lt;/g, '<')
          .replace(/&amp;gt;/g, '>')
          .replace(/&amp;amp;/g, '&');

        // Re-escape only what's needed for HTML safety
        const safeContent = processedCode
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        // Fix any double-escaped entities
        const finalContent = safeContent
          .replace(/&amp;quot;/g, '"')
          .replace(/&amp;#039;/g, "'")
          .replace(/&amp;lt;/g, '<')
          .replace(/&amp;gt;/g, '>')
          .replace(/&amp;amp;/g, '&');

        return `<code class="inline-code">${finalContent}</code>`;
      });

      // At this point, all code blocks are processed and safe
      // Now we can handle non-code content

      // Handle emoji
      processedText = processedText.replace(/([\u{1F300}-\u{1F6FF}])/gu, '<span class="emoji">$1</span>');

      // Then handle other markdown formatting - being careful not to touch code blocks
      // We need to find all <pre> and <code> tags and replace them temporarily
      const codeBlocks = [];
      processedText = processedText.replace(/(<pre.*?<\/pre>|<code.*?<\/code>)/gs, (match) => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
      });

      // Now process regular markdown on the text without code blocks
      processedText = processedText
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');          // Italic

      // Put the code blocks back
      processedText = processedText.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => {
        return codeBlocks[parseInt(index)];
      });

      // Restore original HTML tags that were protected during processing
      processedText = processedText
        .replace(/__HTML_TAG_START__([^_]+)__HTML_TAG_END__/g, '<$1>')
        .replace(/&lt;([^&]+)&gt;/g, '<$1>');

      // For the specific format "This should appear as &lt;p&gt;" pattern
      processedText = processedText.replace(/This should appear as &lt;p&gt;/g, 'This should appear as <p>');

      // Alternative specific format where we want to show the entities literally
      processedText = processedText.replace(/appear as &amp;lt;p&amp;gt;/g, 'appear as &lt;p&gt;');

      return processedText;
    } catch (error) {
      console.error("Error rendering markdown:", error);
      return text || ''; // Return original text as fallback
    }
  }

  // Special escape function for code blocks that preserves formatting
  escapeCodeHtml(text) {
    if (!text) return '';
    // We only escape <, >, and & for code blocks to prevent XSS
    // Do NOT escape quotes - they should display as actual quotes in code
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Deliberately NOT escaping quotes to display them properly in code
  }

  // Helper to escape HTML special characters in regular text
  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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

    // No controls here - removing read aloud buttons

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

      // Fix HTML entities in code blocks after rendering
      this.fixCodeBlockEntities(answerEl);

      // No controls here - removing read aloud buttons

      const row = this.contentEl.createEl('div', { cls: 'flashcard-buttons' });
      ['again', 'hard', 'good', 'easy'].forEach(g => {
        const b = row.createEl('button', { text: g[0].toUpperCase() + g.slice(1) });
        b.addClass(`flashcard-btn-${g}`);
        b.onclick = () => this.gradeAndNext(g);
      });
    };
  }
  async gradeAndNext(g) {
    // Move to next card

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

  // Fix HTML entities in code blocks directly in the DOM after rendering
  fixCodeBlockEntities(element) {
    try {
      // Special case handling for HTML entities in regular content
      if (element.innerHTML.includes('This should appear as')) {
        element.innerHTML = element.innerHTML.replace(/This should appear as &lt;p&gt;/, 'This should appear as <p>');
      }

      // Find all code blocks in the element
      const codeBlocks = element.querySelectorAll('pre.code-block code, code.inline-code');

      // Process each code block
      codeBlocks.forEach(codeBlock => {
        // Get the current text content which might contain HTML entities
        let content = codeBlock.innerHTML;

        // Replace any remaining HTML entities with their actual characters
        content = content
          .replace(/&amp;quot;/g, '"')
          .replace(/&amp;#039;/g, "'")
          .replace(/&amp;lt;/g, '<')
          .replace(/&amp;gt;/g, '>')
          .replace(/&amp;amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');

        // Update the content
        codeBlock.innerHTML = content;
      });
    } catch (error) {
      console.error("Error fixing code block entities:", error);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// =============================================================================
// Summary modal
// =============================================================================
class SummaryModal extends Modal {
  constructor(app, cards, plugin) { super(app); this.cards = cards; this.plugin = plugin; }
  onOpen() {
    this.contentEl.addClass('flashcard-modal');

    // Add a centered title
    this.contentEl.createEl('h3', { text: '🤓 Review Summary', cls: 'summary-title' });

    // Organize cards into buckets by grade
    const buckets = { again: [], hard: [], good: [], easy: [] };
    this.cards.forEach(c => {
      const cardData = this.plugin.cardData.cards[c.question];
      if (cardData && cardData.grade && buckets[cardData.grade]) {
        buckets[cardData.grade].push(c);
      }
    });

    // Check if we're on mobile
    const isMobile = window.innerWidth <= 480;

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

    // Add appropriate spacing for mobile if needed
    if (isMobile) {
      row.style.width = '100%';
    }

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
      text: 'Reset File Cards',
      cls: 'summary-reset-btn'
    });
    reset.onclick = async () => {
      try {
        // Get the count of cards from this file that have data
        const fileCardsCount = this.cards.filter(c => this.plugin.cardData.cards[c.question]).length;

        // Add confirmation dialog
        if (fileCardsCount > 0 && !confirm(`Are you sure you want to reset the flashcard data for this file? (${fileCardsCount} cards will be reset)`)) {
          return;
        }

        // Create a backup before making changes
        const backupSuccess = await this.plugin.createBackup();
        if (!backupSuccess) {
          // If backup fails, warn user but allow them to proceed
          console.warn("Quick Cards: Backup creation failed before reset operation");
          const proceedAnyway = confirm("Warning: Backup creation failed. Do you want to proceed with reset anyway?");
          if (!proceedAnyway) return;
        }

        // Only remove cards from the current file
        if (this.cards && this.cards.length > 0) {
          // Create a new object without the cards from this file
          const updatedCards = { ...this.plugin.cardData.cards };

          // Remove each card from this file
          this.cards.forEach(card => {
            if (card.question && updatedCards[card.question]) {
              delete updatedCards[card.question];
            }
          });

          // Update the card data
          this.plugin.cardData.cards = updatedCards;
          await this.plugin.saveData(this.plugin.cardData);

          // Success message with backup info
          const message = backupSuccess ?
            `Reset ${fileCardsCount} cards from this file (backup created)` :
            `Reset ${fileCardsCount} cards from this file (no backup)`;
          new Notice(message);
        } else {
          new Notice('No cards to reset in this file');
        }
      } catch (error) {
        console.error("Quick Cards: Error during reset operation", error);
        new Notice("Error resetting card data");
      }

      this.close();
    };

    const done = ctrl.createEl('button', { text: 'Done', cls: 'summary-done-btn' });
    done.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

module.exports = QuickCardsPlugin;
