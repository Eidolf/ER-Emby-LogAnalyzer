const fs = require('fs');
const path = require('path');

class KnowledgeBase {
  constructor(customRulesPath = null) {
    this.rules = [];
    this.loadDefaultRules();
    if (customRulesPath && fs.existsSync(customRulesPath)) {
      this.loadCustomRules(customRulesPath);
    }
  }

  loadDefaultRules() {
    try {
      const defaultRulesPath = path.join(__dirname, 'rules.json');
      const data = fs.readFileSync(defaultRulesPath, 'utf8');
      this.rules = JSON.parse(data);
    } catch (err) {
      console.error('Error loading default KB rules:', err);
      this.rules = [];
    }
  }

  loadCustomRules(customPath) {
    try {
      const data = fs.readFileSync(customPath, 'utf8');
      const customRules = JSON.parse(data);
      if (Array.isArray(customRules)) {
        this.rules.push(...customRules);
      }
    } catch (err) {
      console.error('Error loading custom KB rules:', err);
    }
  }

  addRule(rule) {
    if (rule && rule.id && rule.patterns) {
      this.rules.push(rule);
    }
  }

  /**
   * Evaluates text against patterns.
   * @param {string} text - Log line or chunk text
   * @param {string} targetType - 'emby' | 'ffmpeg' | 'all'
   * @returns {Array<object>} Matched rules with match details
   */
  evaluate(text, targetType = 'all') {
    if (!text || typeof text !== 'string') return [];
    const matches = [];

    for (const rule of this.rules) {
      if (rule.target && rule.target !== 'all' && rule.target !== targetType && targetType !== 'all') {
        continue;
      }

      for (const pattern of rule.patterns) {
        try {
          const regex = new RegExp(pattern, 'i');
          const matchResult = text.match(regex);
          if (matchResult) {
            matches.push({
              ruleId: rule.id,
              category: rule.category,
              title: rule.title,
              rootCause: rule.rootCause,
              severity: rule.severity,
              confidence: rule.confidence,
              explanation: rule.explanation,
              recommendations: rule.recommendations,
              matchedPattern: pattern,
              matchedSnippet: matchResult[0],
              contextSnippet: text.trim().slice(0, 300)
            });
            break; // Matched this rule once, move to next rule
          }
        } catch (e) {
          // If regex pattern is invalid, test as literal substring
          if (text.toLowerCase().includes(pattern.toLowerCase())) {
            matches.push({
              ruleId: rule.id,
              category: rule.category,
              title: rule.title,
              rootCause: rule.rootCause,
              severity: rule.severity,
              confidence: rule.confidence,
              explanation: rule.explanation,
              recommendations: rule.recommendations,
              matchedPattern: pattern,
              matchedSnippet: pattern,
              contextSnippet: text.trim().slice(0, 300)
            });
            break;
          }
        }
      }
    }

    return matches;
  }
}

module.exports = KnowledgeBase;
