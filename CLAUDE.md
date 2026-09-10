# PARIDAD — Claude Code Project Instructions

## 1. PROJECT IDENTITY

Project name: **Paridad**

Paridad is a prototype for the **Decentralized AI Hackathon 2026**.

The project addresses a specific problem:

> Independent small businesses often do not know whether they are paying a fair price for the same supplies/products purchased by other businesses. They may benefit from benchmarking, but they do not want to reveal their individual purchase prices or send their invoices to a central server.

Paridad allows multiple businesses to obtain an **aggregate purchasing-price benchmark without exposing their individual prices to a central party or to other participants**.

The core idea is:

```text
Private invoice
      ↓
Local AI
      ↓
Normalized product + price
      ↓
Privacy-preserving aggregation
      ↓
Peer-to-peer exchange
      ↓
Aggregate benchmark
```

The project is NOT a generic chatbot, generic RAG application, generic marketplace, or generic "local AI" wrapper.

The AI and P2P architecture must be essential to the solution.

---

# 2. HACKATHON CONTEXT

Challenge:

> "Construye una solución de inteligencia artificial que funcione donde la nube no llega, no debería llegar o cuesta demasiado."

Requirements:

- The solution must use the QVAC SDK.
- Inference must run on-device or be delegated between peers.
- Routing application inference through a cloud AI API is DISQUALIFYING.
- Cloud services are allowed only for non-inference functions when appropriate.
- P2P communication/delegation is encouraged.
- Repository must be accessible to judges.
- Demo video maximum: 5 minutes.
- Any pre-existing code/base must be declared in README.
- AI coding assistants are allowed.

Evaluation:

- Technical: 35%
- Innovation: 25%
- Impact: 20%
- Design: 10%
- Completion: 10%

The deadline is strict.

Optimize for a working, demonstrable technical MVP rather than feature quantity.

---

# 3. COMPETITIVE CONTEXT

Known projects already published in the hackathon include:

- PULSO — local AI for medical emergency documentation.
- MangoApp — supply-chain platform for Panama.
- ProofAI — field observations to structured data.
- TBD-Panama — local AI assistant.
- ATLAS — hospital inventory extraction.
- Onby — employee onboarding.
- Salus — private family medical memory.
- Perseus AI — decentralized disaster response.

Avoid building a project that is substantially equivalent to any of these.

Known saturated/problematic patterns:

- Generic local chatbot.
- Local RAG.
- Personal private memory.
- Medical assistant.
- Medical triage.
- Disaster response.
- Hospital inventory.
- Field observation → structured JSON.
- Generic supply-chain marketplace.
- Generic offline AI assistant.
- Secret scanner + chatbot.
- AI agent with no strong domain problem.

Paridad must differentiate through:

1. Multiple independent participants.
2. Participants do not need to trust one another.
3. Private data remains local.
4. AI processes the original document locally.
5. P2P is part of the actual protocol.
6. Aggregate information is obtained without a central party seeing individual prices.

---

# 4. CORE PRODUCT PRINCIPLE

The most important architectural principle is:

> The local AI is the privacy boundary.

The invoice itself must never need to leave the originating device.

QVAC should perform local operations such as:

```text
Image
 ↓
OCR
 ↓
Structured extraction
 ↓
Product normalization
 ↓
Private aggregation
```

Only the minimum information required by the aggregation protocol may cross the P2P boundary.

Individual raw prices, invoices, OCR text, supplier names, or other private business information must never be sent to a central server.

---

# 5. CURRENT TECHNICAL ENVIRONMENT

Primary developer machine:

- Windows
- AMD Ryzen 5 5500U
- 16 GB RAM
- AMD Radeon integrated graphics
- Approximately 1 GB graphics memory
- Node.js 24.21.0
- npm 11.19.0
- Claude Code 2.1.266
- QVAC CLI installed
- QVAC SDK 0.19.0

QVAC validation already completed successfully:

- `qvac doctor` passes.
- Vulkan acceleration is detected.
- QVAC local model loads successfully.
- `qwen3-600m-inst-q4` loads successfully.
- Local inference works.
- `qvac serve --openai` works.
- `/v1/chat/completions` works locally.

Do NOT repeat these setup steps unless a regression occurs.

---

# 6. CURRENT PROJECT STATE

The project already contains:

```text
package.json
node_modules/
qvac.config.json
test-qvac.mjs

src/
└── privacy/
    ├── secret-sharing.mjs
    └── test-secret-sharing.mjs

nodo-a.mjs
nodo-b.mjs
```

Dependencies already installed:

- `@qvac/sdk`
- `hyperswarm`
- `@hyperswarm/rpc`

The following validations are already complete:

### QVAC

```text
QVAC ✅
Vulkan ✅
Local model ✅
Local inference ✅
```

### Hyperswarm

Two local processes have successfully communicated bidirectionally:

```text
Node A ↔ Node B
```

### Secret sharing

100 randomized tests passed.

Example:

```text
Price A = 4700 cents
Price B = 3100 cents
Price C = 5200 cents

Total = 13000
Average = 4333 cents
```

The sharing/reconstruction logic works.

DO NOT delete or rewrite validated components without a concrete reason.

---

# 7. IMPORTANT QVAC VERSION CONSTRAINT

The project currently uses QVAC 0.19.0.

Do NOT assume that examples from older QVAC versions are compatible.

In particular:

- Do not assume delegated inference APIs from older versions exist.
- Do not use deprecated APIs simply because they appear in old examples.
- Verify the installed SDK/API before implementing against documentation or examples.

If there is uncertainty about a QVAC API, inspect the locally installed package, current documentation, or use a minimal isolated test before integrating it into the project.

Prefer official QVAC APIs.

---

# 8. P2P ARCHITECTURE

Paridad requires real peer-to-peer communication.

The current direction is:

```text
                   PARIDAD NODE A
┌───────────────────────────────────────────┐
│                                           │
│ Invoice image                             │
│      ↓                                    │
│ QVAC OCR                                  │
│      ↓                                    │
│ QVAC structured extraction                │
│      ↓                                    │
│ QVAC embeddings / normalization           │
│      ↓                                    │
│ canonical product + private price         │
│      ↓                                    │
│ privacy-preserving share                  │
│      ↓                                    │
│              Hyperswarm / RPC             │
└──────────────────────┬────────────────────┘
                       │
                       │ P2P
                       │
┌──────────────────────┴────────────────────┐
│                                           │
│                PARIDAD NODE B             │
│                                           │
│ Invoice image                             │
│      ↓                                    │
│ QVAC local processing                     │
│      ↓                                    │
│ canonical product + private price         │
│      ↓                                    │
│ privacy-preserving share                  │
│                                           │
└───────────────────────────────────────────┘
```

Potential extension:

```text
Node A
Node B
Node C
```

Three participants are preferred/required for the privacy model used in the MVP's final benchmark.

---

# 9. PRIVACY MODEL

The current aggregation concept uses additive secret sharing.

For a private value `v` and `n` participants:

```text
v → share1 + share2 + ... + sharen  (mod p)
```

Individual shares must not reveal the original value.

The reconstruction process must only reveal the aggregate.

For the final benchmark:

```text
aggregate = sum(all participant values)
average = aggregate / participant_count
```

The implementation must ensure that individual prices are never transmitted directly.

Do not replace this protocol with plain:

```text
send(price)
```

Do not log individual prices in network messages.

Do not store individual participant prices centrally.

---

# 10. PARTICIPANT PRIVACY RULE

For the final MVP:

- Minimum target: 3 participants.
- Never reveal another participant's individual price.
- Do not identify businesses by real names in the aggregation layer.
- Do not identify specific suppliers in the aggregation layer.
- Do not use future/prospective pricing data.
- Focus on historical purchase prices.
- Focus on purchasing prices, not selling prices.

These restrictions are part of the product design, not optional documentation.

If a proposed feature conflicts with them, reject the feature unless explicitly approved by the project owners.

---

# 11. WHAT QVAC SHOULD DO

Use QVAC for actual AI responsibilities.

Preferred pipeline:

```text
Invoice image
    ↓
QVAC OCR
    ↓
QVAC completion / structured JSON
    ↓
QVAC embeddings or deterministic normalization
    ↓
Canonical product
```

Example output:

```json
{
  "product": "oil 20w50",
  "quantity": 4,
  "unit_price_cents": 4700
}
```

The exact schema may evolve.

Do not use an external cloud AI API for any inference.

Do not send invoices to OpenAI, Anthropic, Google, or any other external AI provider.

---

# 12. MODEL / HARDWARE RULES

The main development machine has 16 GB RAM and integrated AMD graphics.

Prefer small QVAC-compatible models.

Current known successful model:

```text
qwen3-600m-inst-q4
```

Prioritize:

- reliability;
- predictable latency;
- low RAM usage;
- structured output.

Do not introduce large models merely because they produce better prose.

Do not optimize for generic chatbot quality.

Paridad is a structured-data application.

---

# 13. NETWORKING RULES

Hyperswarm/P2P must be real.

Do not fake P2P with a central backend.

Do not create a central server that receives every price.

Do not silently fall back to a cloud service.

The expected architecture is:

```text
Node A ↔ P2P ↔ Node B ↔ P2P ↔ Node C
```

Use `@hyperswarm/rpc` for request/response semantics when appropriate instead of implementing unnecessary custom RPC framing.

Always cleanly shut down networking resources:

```javascript
await swarm.destroy();
```

Avoid stale network state between test runs.

---

# 14. OFFLINE / LOCAL NETWORK REQUIREMENT

A critical demo goal is:

```text
Internet OFF
       ↓
Local network still works
       ↓
P2P communication continues
       ↓
QVAC inference continues
```

Do NOT falsely claim that the system works without any network if the current peer-discovery mechanism still requires an external bootstrap service.

The preferred final architecture should use a local bootstrap/discovery mechanism so the demo can truthfully demonstrate operation without dependence on public infrastructure.

Before relying on this in the demo, verify it experimentally.

---

# 15. DEVELOPMENT ORDER

Never start with the UI.

Build in this order:

## Phase 1 — Local AI pipeline

```text
invoice
 ↓
OCR
 ↓
structured JSON
 ↓
canonical product
```

## Phase 2 — Privacy mathematics

```text
price
 ↓
shares
 ↓
aggregate
 ↓
original aggregate
```

## Phase 3 — P2P

```text
share
 ↓
Hyperswarm
 ↓
other node
```

## Phase 4 — End-to-end

```text
invoice A → QVAC → private share
invoice B → QVAC → private share
invoice C → QVAC → private share
                           ↓
                       P2P aggregate
                           ↓
                         result
```

## Phase 5 — UI

Only after the end-to-end pipeline is functional.

---

# 16. MVP SCOPE

The MVP is complete when:

- A participant can provide a test invoice image.
- QVAC processes the invoice locally.
- The system extracts product + price.
- Equivalent products can be normalized.
- A private share is generated.
- Shares can be exchanged through P2P.
- A group aggregate can be computed.
- Individual prices are not exposed through the network.
- The system can show participant count.
- The system can show benchmark result.
- The system can handle at least one participant disconnecting gracefully.
- The core demonstration works without cloud inference.

---

# 17. DO NOT BUILD

Unless explicitly approved, DO NOT build:

- authentication;
- accounts;
- SaaS billing;
- subscriptions;
- production database;
- cloud AI;
- mobile application;
- blockchain;
- tokens;
- crypto payments;
- complex dashboards;
- full enterprise administration;
- supplier marketplace;
- real-time pricing;
- automatic supplier discovery;
- large-scale deployment infrastructure;
- Kubernetes;
- multi-tenant SaaS;
- complicated user management;
- unnecessary animations;
- more than the minimum number of nodes required for the demo.

When deciding between two approaches, prefer the one with fewer moving parts.

---

# 18. CLAUDE CODE WORKING STYLE

Claude Code must behave as a senior engineering agent.

Before making a major architectural change:

1. Inspect the existing code.
2. Understand current behavior.
3. Preserve validated functionality.
4. Make the smallest viable change.
5. Run tests.
6. Report what changed.

Do not rewrite working modules just to "clean them up".

Do not introduce frameworks unless they solve a demonstrated problem.

Do not add dependencies without justification.

Prefer standard Node.js / TypeScript functionality when sufficient.

Keep modules small.

Avoid speculative abstractions.

Do not create architecture for features that are explicitly out of scope.

---

# 19. TESTING REQUIREMENTS

Every critical subsystem should have a minimal test.

At minimum:

### Secret sharing

Test:

- random values;
- zero;
- small values;
- larger values;
- multiple participants;
- repeated runs.

### Product normalization

Test different textual variations of the same product.

Example:

```text
Aceite Motor 20W50
aceite 20-w-50
AC MOTOR 20W50
```

should resolve to the same canonical product when appropriate.

### P2P

Test:

- connection;
- message exchange;
- timeout;
- node disconnect;
- cleanup.

### End-to-end

Test:

```text
invoice → extraction → share → P2P → aggregate
```

---

# 20. DATA / DEMO RULES

Use synthetic or team-created demo data.

Do not depend on:

- live business data;
- confidential customer data;
- third-party credentials;
- external APIs;
- external AI services.

Create clean demonstration invoices if real invoices are unreliable.

The demo must be deterministic enough to work repeatedly.

If OCR is fragile on arbitrary invoices, the MVP should use carefully prepared invoice images rather than pretending arbitrary documents are supported.

---

# 21. DEMO GOAL

The five-minute demo should communicate one idea:

> Multiple businesses can discover whether they are paying above or below the group benchmark without revealing their individual prices.

Ideal technical demonstration:

```text
Business A
Invoice → local QVAC → private value

Business B
Invoice → local QVAC → private value

Business C
Invoice → local QVAC → private value

                 ↓

              P2P

                 ↓

        aggregate benchmark

                 ↓

"Your price is 20% above the group average."
```

The strongest possible demo visually shows:

- QVAC executing locally;
- three peers;
- private shares crossing the network;
- no individual price being transmitted;
- aggregate result;
- Internet unavailable or intentionally disconnected if the offline-network implementation has been verified.

---

# 22. UX PRINCIPLES

The interface should make the distributed/privacy properties visible.

Prefer showing:

```text
PEERS: 3
P2P: CONNECTED
INTERNET: OFFLINE
LOCAL AI: ACTIVE
PRIVATE DATA SHARED: 0
```

And:

```text
Your price:     hidden
Group average:  $43.33
Your position:  +8.5%
Participants:   3
```

Do not expose private peer values merely to make the demo easier to understand.

Show masked/randomized shares when useful.

---

# 23. PRODUCT LANGUAGE

Use careful language.

Preferred:

- privacy-preserving;
- locally processed;
- no central price database;
- peer-to-peer;
- aggregated;
- verifiable behavior;
- local inference;
- private by design.

Avoid unsupported absolute claims such as:

- "100% secure";
- "mathematically impossible to leak";
- "unhackable";
- "perfect privacy";
- "no one can ever know anything".

Do not claim that no equivalent product exists.

Use wording such as:

> "We did not find evidence of an equivalent implementation combining local invoice understanding with decentralized private aggregation."

---

# 24. PANAMA POSITIONING

Panama is a potential market/context, not an excuse to add artificial local branding.

When discussing Panama, focus on real characteristics such as:

- large number of MiPymes;
- informal/small-business context;
- paper-based records;
- digitalization gaps;
- businesses that may not want to expose commercial data to centralized platforms.

Do not invent statistics.

Do not claim official relationships with Panamanian institutions.

Do not imply partnership with suppliers or companies unless one actually exists.

---

# 25. README REQUIREMENTS

The final README must clearly document:

- project purpose;
- hackathon;
- architecture;
- QVAC usage;
- P2P architecture;
- how local inference works;
- how privacy-preserving aggregation works;
- installation instructions;
- execution instructions;
- known limitations;
- demo instructions;
- all substantial pre-existing code/components and their origins.

The hackathon requires disclosure of pre-existing bases/components.

Never hide or omit pre-existing material.

---

# 26. SECURITY / COMPLIANCE

Never place:

- API keys;
- passwords;
- private credentials;
- personal information;
- real business confidential data

into the repository.

Use `.env.example` only when environment variables are genuinely required.

Do not add an external AI provider as a fallback.

If QVAC fails, fail clearly rather than silently sending inference to a cloud service.

---

# 27. DECISION RULE

When uncertain between features, use this priority:

1. Technical functionality.
2. Demonstrable innovation.
3. Genuine QVAC usage.
4. Genuine P2P usage.
5. Impact.
6. Reliability.
7. UX.
8. Additional features.

A feature that is impressive but fragile should normally be rejected.

A feature that is simple but reliable should normally be preferred.

---

# 28. TIME MANAGEMENT RULE

This is a 48-hour hackathon.

Do not chase perfection.

At approximately the midpoint of the build, anything not contributing directly to:

```text
QVAC
+
P2P
+
privacy-preserving aggregation
+
clear demo
```

should be considered for removal.

Do not expand scope late in the project.

Do not change the core concept without explicit approval from the project owners.

---

# 29. BEFORE IMPLEMENTING ANYTHING

When given a development request, first determine:

- Does this contribute directly to Paridad?
- Does it preserve QVAC/local inference requirements?
- Does it preserve the P2P/privacy architecture?
- Is it achievable within the remaining hackathon time?
- Does it introduce unnecessary dependencies?
- Does it weaken the demo?

If the answer is no, recommend against the change.

---

# 30. CURRENT NEXT OBJECTIVE

The immediate technical goal is:

```text
LOCAL QVAC PIPELINE
+
LOCAL PRIVACY PROTOCOL
+
REAL P2P
=
END-TO-END PARIDAD
```

The next implementation milestone is to connect the already-tested secret-sharing logic to the already-tested Hyperswarm communication.

Do not start building the final UI until this works.

---

# 31. GOLDEN RULE

The project should always be explainable in one sentence:

> **Paridad lets independent businesses compare what they pay for the same product without revealing their individual prices or sending their invoices to a central server.**

Every major architectural decision should reinforce that sentence.

If a feature does not reinforce it, question whether it belongs in the hackathon MVP.