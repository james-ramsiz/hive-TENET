Freelance EV Arbitrage — Chrome Extension
Real-time expected-value verdicts on freelance job posts, powered by the same
RL-learned bidding policy as the Freelance Arbitrage Dashboard.

What it does
When you open a job post on PeoplePerHour, Upwork, or Fiverr, the
extension scrapes the page for budget, proposal count, client rating, and
payment-verification signals, then overlays a verdict banner:

text

🚀 BOOST
EV: £142 · Win rate: 9.2% · Net if won: £1,290
High-value job in the optimal boost band (£700–£3,000)
Competition: ~12 proposals · Client: ★★★★★ 4.9 · Payment verified ✓
RL policy + greedy EV · skill 70%
Install (Chrome / Edge / Brave — any MV3 browser)
Open chrome://extensions
Enable Developer mode (top-right toggle)
Click Load unpacked
Select this folder (freelance-ev-extension)
Open any PPH/Upwork/Fiverr job post — the banner appears top-right
Configure
Click the extension icon to set your skill level and hourly rate.
These feed the win-rate curve and EV computation.

The policy inside
Transplanted from a Q-learning agent trained on 4,000 simulated 52-week
bidding episodes:

Job value
Action
< £300	SKIP
£300–£700	BID
£700–£3,000	BOOST
> £3,000	SKIP (unless win rate ≥ 8%)

The greedy-EV computation runs alongside and both signals are blended —
the RL policy wins ties because it learned credit conservation.

Limitations
Platforms redesign frequently; DOM selectors may need updates
(all in SELECTORS at the top of content.js)
The extension fails soft: if a page doesn't match, it does nothing
Win-rate curves are reconstructed estimates, not platform data
