// HAOL Demo — Pre-scripted demo prompts
//
// `display` is the short text shown on the card button.
// `prompt` is the full text loaded into the textarea and sent to the API.
// Keep trigger-word behavior stable: only the original display sentence
// should contain (or avoid) routing keywords.

const DEMO_PROMPTS = [
  {
    label: "The Gimme",
    display: "Summarize this paragraph about renewable energy adoption in developing nations.",
    prompt: `Summarize this paragraph about renewable energy adoption in developing nations.

Renewable energy adoption in developing nations has accelerated significantly over the past decade, driven by falling costs of solar and wind technology, international climate financing, and growing domestic demand for reliable electricity. Countries like India, Kenya, and Brazil have emerged as leaders in deploying distributed solar systems, often leapfrogging traditional grid infrastructure entirely. However, challenges remain: intermittent supply, limited battery storage capacity, and regulatory frameworks that still favor fossil fuel incumbents. The International Energy Agency estimates that developing nations will account for over 60% of new renewable capacity additions by 2030, but only if current policy momentum is sustained and financing gaps are addressed.`,
    description: "Deterministic rules catch 'summariz' instantly. No API call needed.",
  },
  {
    label: "The Curveball",
    display: "Pull out the key points from this customer feedback report.",
    prompt: `Pull out the key points from this customer feedback report.

Q3 2025 Customer Feedback Summary — Enterprise Tier

Overall satisfaction: 7.2/10 (down from 7.8 in Q2)

Top themes from 342 survey responses and 89 support tickets:
- Onboarding experience rated highly (8.1/10), particularly the dedicated account manager program
- API documentation received the most negative feedback; customers cited outdated examples and missing edge-case coverage
- Billing transparency was flagged by 23% of respondents, specifically around overage charges on the usage-based tier
- Feature request: 41 customers independently requested webhook support for real-time event notifications
- Churn risk indicators: 12 accounts mentioned looking at competitors, primarily citing price and integration flexibility
- Support response times improved to 2.4hr average (from 3.1hr in Q2), but first-contact resolution dropped to 64%`,
    description: "No trigger words. Semantic similarity resolves it by understanding intent.",
  },
  {
    label: "The Ambiguous One",
    display: "Given these constraints, what would be the most pragmatic way to solve this?",
    prompt: `Given these constraints, what would be the most pragmatic way to solve this?

We have a legacy internal knowledge base with ~15,000 documents (policies, procedures, FAQs) that employees currently search via keyword. The search quality is poor — employees spend an average of 12 minutes per query and still fail to find the right document 30% of the time.

We want to put a conversational AI layer in front of it, but:
- The documents are in mixed formats (PDF, Word, HTML, some scanned images)
- Content is updated weekly by 8 different departments with no centralized review
- Some documents contain sensitive HR and legal information with role-based access
- Our IT team has 2 engineers available part-time for this project
- Budget for the pilot is $5,000/month including all API and infrastructure costs
- We need a working prototype within 6 weeks`,
    description: "Too vague for rules or embeddings. Escalates to LLM classification.",
  },
  {
    label: "The Heavy Hitter",
    display: "Analyze this screenshot of a dashboard and generate the corresponding React component.",
    prompt: `Analyze this screenshot of a dashboard and generate the corresponding React component with TypeScript types.

The dashboard shows a real-time metrics panel with the following layout:
- Top row: 4 KPI cards (Total Revenue: $1.2M, Active Users: 34,521, Conversion Rate: 3.2%, Avg Session: 4m 32s). Each card has a trend arrow and percentage change vs prior period.
- Middle section: A line chart showing daily active users over the past 30 days, with a secondary y-axis for revenue. The chart has a tooltip that shows exact values on hover.
- Bottom section: A sortable data table with columns for Campaign Name, Spend, Impressions, Clicks, CTR, and Conversions. The table has pagination (25 rows per page) and a search filter.
- Color scheme: dark sidebar (#1a1a2e), white content area, accent blue (#4361ee) for primary actions, green/red for positive/negative trends.
- The component should use Recharts for the chart, be fully responsive, and include proper loading and empty states.
- The dashboard must support multilingual labels — all visible text (headers, tooltips, axis labels, column names) should be driven by an i18n translation object passed as a prop, with English as the default locale.`,
    description: "Multi-capability routing: vision + code + reasoning + multilingual. Routes to the most capable agent.",
  },
  {
    label: "The Escalator",
    display: "Look at the attached UI mockup and write the React component that reproduces it.",
    prompt: `Look at the attached UI mockup and write the React component that reproduces it, including proper TypeScript interfaces for the props.

The mockup shows a settings page with a two-column layout:
- Left column (240px): A vertical navigation menu with sections for Profile, Security, Notifications, Billing, and Team. The active item has a blue left border and light blue background.
- Right column: The content area for the active section. Currently showing "Notifications" with toggle switches for Email Digests (on), Slack Alerts (on), SMS for Critical (off), and Weekly Report (on). Each toggle has a title, description text, and an on/off switch aligned to the right.
- Below the toggles: A "Quiet Hours" section with two time pickers (start/end) and a timezone dropdown.
- Footer: A "Save Changes" primary button and a "Reset to Defaults" text button.
- The component should handle state for all toggles and time pickers, with an unsaved changes indicator in the header when modifications are pending.`,
    description: "Dodges every keyword rule and embedding match. Forces LLM escalation to classify.",
  },
];
