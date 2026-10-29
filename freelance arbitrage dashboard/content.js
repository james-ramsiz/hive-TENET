/**
 * content.js — Freelance EV Arbitrage content script
 *
 * Detects job posting pages on PPH / Upwork / Fiverr, extracts budget and
 * client-quality signals from the DOM, computes expected value using the
 * same models from the dashboard (win-rate curves + RL-learned thresholds),
 * and overlays a SKIP / BID / BOOST verdict banner on the page.
 *
 * NOTE ON SELECTORS: Platforms redesign frequently. The selectors below
 * target current (2025) page structures and are designed to fail soft —
 * if nothing matches, the extension silently does nothing. Update the
 * SELECTORS map when layouts change.
 */

// ============================================================
// Platform-specific DOM selectors
// ============================================================
const SELECTORS = {
  peopleperhour: {
    // Job detail pages
    hostMatch: 'peopleperhour.com',
    jobUrlPattern: /\/(services\/[^/]+\/(job|project)s?\/|hourlies\/[^/]+)|\/project\/detail/i,
    budgetSelectors: [
      // PPH shows "Budget: £X" or a budget pill
      '[class*="budget"]',
      '[data-testid*="budget"]',
    ],
    budgetRegex: /[£$€]\s?([\d,]+(?:\.\d+)?)/,
    clientRatingSelectors: ['[class*="rating"]', '[class*="stars"]'],
    proposalCountSelectors: ['[class*="proposals"]', '[class*="offers"]'],
    proposalCountRegex: /(\d+)/,
    paymentVerifiedSelectors: ['[class*="verified"]', '[class*="payment"]'],
  },
  upwork: {
    hostMatch: 'upwork.com',
    jobUrlPattern: /\/(job|jobs)\//i,
    budgetSelectors: [
      '[data-test*="budget"]',
      '[class*="BudgetAmount"]',
      '[class*="budget"]',
    ],
    budgetRegex: /[$£€]\s?([\d,]+(?:\.\d+)?)/,
    clientRatingSelectors: ['[data-test*="rating"]', '[class*="rating"]'],
    proposalCountSelectors: ['[data-test*="proposal"]', '[class*="proposal"]'],
    proposalCountRegex: /(\d+)/,
    paymentVerifiedSelectors: ['[data-test*="verified"]', '[class*="verified"]'],
  },
  fiverr: {
    hostMatch: 'fiverr.com',
    // Brief pages when a buyer sends a request
    jobUrlPattern: /\/(briefs|requests)\//i,
    budgetSelectors: ['[class*="budget"]'],
    budgetRegex: /[$£€]\s?([\d,]+(?:\.\d+)?)/,
    clientRatingSelectors: ['[class*="rating"]'],
    proposalCountSelectors: ['[class*="offer"]'],
    proposalCountRegex: /(\d+)/,
    paymentVerifiedSelectors: [],
  },
};

// ============================================================
// EV engine — mirrors the dashboard's models
// ============================================================
const GBP_PER = { USD: 1 / 1.27, GBP: 1, EUR: 1 / 1.17 };

function detectCurrency(text) {
  if (!text) return 'GBP';
  if (text.includes('$')) return 'USD';
  if (text.includes('€')) return 'EUR';
  return 'GBP';
}

function toGbp(amount, currency) {
  return amount * (GBP_PER[currency] ?? 1);
}

/**
 * Win-rate curve per platform, conditioned on job value.
 * Reconstructed from the dashboard's simulation models.
 */
function estimateWinRate(platform, budgetGbp, profile) {
  const skillFactor = 0.7 + 0.6 * profile.skillLevel;
  const base = {
    peopleperhour: 0.06 + profile.skillLevel * 0.05,
    upwork: 0.035 + profile.skillLevel * 0.04,
    fiverr: 0.05 + profile.skillLevel * 0.03,
  }[platform] ?? 0.05;
  // Bigger jobs are harder to win (steepness 0.25)
  const sizeFactor = Math.pow(700 / Math.max(budgetGbp, 200), 0.25);
  const saturation = 0.9; // adjusted by proposal count below
  return Math.max(0.01, base * skillFactor * sizeFactor);
}

function adjustForCompetition(winRate, numProposals) {
  if (numProposals == null) return winRate;
  // More proposals → lower win rate, log-damped
  const penalty = Math.min(0.5, Math.log1p(numProposals) * 0.07);
  return Math.max(0.01, winRate * (1 - penalty));
}

function adjustForClientQuality(winRate, clientRating, paymentVerified) {
  let adj = 1.0;
  if (clientRating != null) {
    adj *= 0.8 + (clientRating / 5) * 0.3;
  }
  if (paymentVerified === false) adj *= 0.85;
  return winRate * adj;
}

// Per-platform fee rates on revenue
const FEE_RATE = {
  peopleperhour: 0.075, // blended sliding scale
  upwork: 0.10,
  fiverr: 0.20,
};

// Per-bid costs (GBP)
const BID_COST = {
  peopleperhour: 15 * 0.08, // 15 credits
  upwork: 15 * (0.06 / 1.27), // 15 connects
  fiverr: 0,
};
const BOOST_COST = {
  peopleperhour: 30 * 0.08, // 30 credits (bid + boost)
  upwork: 40 * (0.06 / 1.27),
  fiverr: 0,
};

/**
 * The RL-learned policy (transplanted from the Q-table):
 *   skip < £300
 *   bid £300–£700
 *   boost £700–£3,000
 *   skip > £3,000 (unwinnable tier for mid-skill)
 * ...but we also compute greedy EV to blend both signals.
 */
function computeVerdict(platform, budgetGbp, winRate) {
  const fee = FEE_RATE[platform] ?? 0.1;
  const netRev = budgetGbp * (1 - fee);
  const bidCost = BID_COST[platform] ?? 1;
  const boostCost = BOOST_COST[platform] ?? 2;

  const evBid = winRate * netRev - bidCost;
  const evBoost = (winRate + 0.06) * netRev - boostCost;
  const evSkip = 0;

  // Greedy EV choice
  let evAction = 'skip';
  let evValue = 0;
  if (evBoost > evBid && evBoost > 0) {
    evAction = 'boost';
    evValue = evBoost;
  } else if (evBid > 0) {
    evAction = 'bid';
    evValue = evBid;
  }

  // RL policy choice
  let rlAction = 'skip';
  if (budgetGbp >= 300 && budgetGbp < 700) rlAction = 'bid';
  else if (budgetGbp >= 700 && budgetGbp <= 3000) rlAction = 'boost';
  else if (budgetGbp > 3000 && winRate >= 0.08) rlAction = 'bid';

  // Blend: RL wins ties (it learned credit conservation)
  const action = evValue > 0 ? (rlAction === evAction ? evAction : (evValue > 50 ? evAction : rlAction)) : 'skip';

  return {
    action,
    ev: Math.max(evValue, 0),
    evBid,
    evBoost,
    winRate,
    netRev,
  };
}

// ============================================================
// Page scraping
// ============================================================
function firstMatchingText(selectors, regex) {
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const text = el.textContent?.trim() || '';
      const m = text.match(regex);
      if (m) {
        return { el, text, match: m[1] };
      }
    }
  }
  return null;
}

function extractBudget(cfg) {
  const hit = firstMatchingText(cfg.budgetSelectors, cfg.budgetRegex);
  if (!hit) return null;
  const amount = parseFloat(hit.match.replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    currency: detectCurrency(hit.text),
    gbp: toGbp(amount, detectCurrency(hit.text)),
    el: hit.el,
  };
}

function extractProposalCount(cfg) {
  const hit = firstMatchingText(cfg.proposalCountSelectors, cfg.proposalCountRegex);
  if (!hit) return null;
  const n = parseInt(hit.match, 10);
  return isFinite(n) ? n : null;
}

function extractClientRating(cfg) {
  // Look for star ratings: "4.8" near star icons, or aria-labels
  for (const sel of cfg.clientRatingSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      const aria = el.getAttribute('aria-label') || '';
      const m = aria.match(/([\d.]+)\s*(?:out of|\/)\s*5/) || el.textContent?.match(/\b([1-5](?:\.\d+)?)\b/);
      if (m) {
        const rating = parseFloat(m[1]);
        if (rating >= 1 && rating <= 5) return rating;
      }
    }
  }
  return null;
}

function extractPaymentVerified(cfg) {
  if (!cfg.paymentVerifiedSelectors?.length) return null;
  for (const sel of cfg.paymentVerifiedSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('verified')) return true;
    }
  }
  return null;
}

// ============================================================
// Overlay UI
// ============================================================
const ACTION_STYLES = {
  skip: {
    label: 'SKIP',
    color: '#71717a',
    bg: '#18181b',
    border: '#3f3f46',
    icon: '⏭️',
    reason: 'Negative expected value — credits/time better spent elsewhere',
  },
  bid: {
    label: 'BID',
    color: '#38bdf8',
    bg: '#082f49',
    border: '#0369a1',
    icon: '✋',
    reason: 'Positive EV without boost — standard application recommended',
  },
  boost: {
    label: 'BOOST',
    color: '#34d399',
    bg: '#052e16',
    border: '#166534',
    icon: '🚀',
    reason: 'High-value job in the optimal boost band (£700–£3,000)',
  },
};

function buildOverlay(verdict, profile, meta) {
  const s = ACTION_STYLES[verdict.action];
  const overlay = document.createElement('div');
  overlay.id = 'ev-arbitrage-overlay';
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:22px;">${s.icon}</span>
      <div>
        <div style="font-weight:800;font-size:15px;letter-spacing:1px;color:${s.color};">
          ${s.label}
        </div>
        <div style="font-size:11px;color:#a1a1aa;">
          EV: <b style="color:${verdict.ev > 0 ? '#34d399' : '#71717a'}">£${verdict.ev.toFixed(0)}</b>
          · Win rate: <b>${(verdict.winRate * 100).toFixed(1)}%</b>
          · Net if won: <b>£${Math.round(verdict.netRev)}</b>
        </div>
      </div>
    </div>
    <div style="margin-top:6px;font-size:10px;color:#71717a;line-height:1.4;">
      ${s.reason}
      ${meta.proposals != null ? `<br>Competition: ~${meta.proposals} proposals` : ''}
      ${meta.clientRating != null ? ` · Client: ${'★'.repeat(Math.round(meta.clientRating))} ${meta.clientRating}` : ''}
      ${meta.paymentVerified ? ' · Payment verified ✓' : ''}
    </div>
    <div style="margin-top:4px;font-size:9px;color:#52525b;">
      RL policy + greedy EV · skill ${Math.round(profile.skillLevel * 100)}%
    </div>
  `;
  overlay.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 99999;
    background: ${s.bg}; border: 1px solid ${s.border};
    border-radius: 10px; padding: 10px 14px;
    font-family: -apple-system, system-ui, sans-serif;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    max-width: 300px;
  `;
  return overlay;
}

// ============================================================
// Main
// ============================================================
const DEFAULT_PROFILE = { skillLevel: 0.7, hourRate: 60 };

let lastUrl = location.href;

function run() {
  // Remove stale overlay on SPA navigation
  document.getElementById('ev-arbitrage-overlay')?.remove();

  const host = location.hostname;
  let platformKey = null;
  if (host.includes('peopleperhour')) platformKey = 'peopleperhour';
  else if (host.includes('upwork')) platformKey = 'upwork';
  else if (host.includes('fiverr')) platformKey = 'fiverr';
  if (!platformKey) return;

  const cfg = SELECTORS[platformKey];
  if (!cfg.jobUrlPattern.test(location.pathname)) return;

  chrome.storage.local.get(['profile'], (data) => {
    const profile = { ...DEFAULT_PROFILE, ...(data?.profile || {}) };

    const budget = extractBudget(cfg);
    if (!budget) return; // not a job detail page or budget not found

    const proposals = extractProposalCount(cfg);
    const clientRating = extractClientRating(cfg);
    const paymentVerified = extractPaymentVerified(cfg);

    let winRate = estimateWinRate(platformKey, budget.gbp, profile);
    winRate = adjustForCompetition(winRate, proposals);
    winRate = adjustForClientQuality(winRate, clientRating, paymentVerified);

    const verdict = computeVerdict(platformKey, budget.gbp, winRate);
    const overlay = buildOverlay(verdict, profile, { proposals, clientRating, paymentVerified });
    document.body.appendChild(overlay);
  });
}

// SPA navigation hook (all three platforms are SPAs)
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(run, 1200); // wait for dynamic content
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });

// Initial run (with delay for SPA hydration)
setTimeout(run, 1500);
