# DFLCKT Product & Messaging Principles

These principles are durable constraints for product design, architecture, and public-facing copy. Future rewrites should preserve them unless deliberately revised.

## Core proposition

**Choice is the product. Privacy is the architecture.**

DFLCKT helps a driver understand known surveillance exposure along possible routes and make their own tradeoff among time, distance, and exposure. DFLCKT does not decide that avoiding surveillance is always the correct choice; it makes the choice visible and understandable.

A useful plain-language expression is:

> **See the surveillance on your route. Choose how much you want to avoid.**

The interface should demonstrate that choice concretely, for example:

- Fastest — 24 min
- Lower exposure — 27 min
- Lowest known exposure — 34 min

## Privacy proposition

A product intended to give people more control over surveillance exposure must not itself become another source of movement surveillance.

A useful public-facing expression is:

> **Your privacy shouldn’t cost you your privacy.**
> DFLCKT is designed to help you make that choice without creating another record of where you’ve been.

The intended user reaction is: **“I want to be able to make a choice, and I don’t want the service giving me that choice to become another way my data is saved, tracked, or shared.”**

Where the production architecture supports the claims, prefer concrete, testable statements over generic language such as “we don’t track you,” e.g.:

- No trip history.
- No saved destinations.
- No advertising profile.
- No sale or sharing of movement data.

Do not publish an absolute privacy promise until the implementation actually makes it true.

## Public messaging hierarchy

A visitor should understand the proposition almost immediately:

**Know what’s ahead → See your choices → Pick your tradeoff → Leave no trail with us.**

Privacy is not a secondary legal page or generic brand virtue. It belongs in the primary product story alongside route choice.

## Positioning

DFLCKT should not rely on generic “private navigation” as its differentiator. The stronger distinction is that **surveillance exposure itself becomes a routing variable**, while the service is deliberately designed not to turn the resulting route decision into another movement-history dataset.

DFLCKT should also remain vendor-neutral as a brand. Flock/ALPR awareness may be the current entry point because of public interest, but the long-term product category is broader surveillance-aware navigation rather than an app defined around one surveillance vendor.

## Working freemium strategy hypothesis

**Flock/ALPR avoidance acquires the user. Comprehensive surveillance-aware navigation monetizes the user.**

Treat this as a business hypothesis to validate, not a permanent pricing commitment.

The working model is:

- **Free:** useful Flock/ALPR route awareness and basic avoidance. The free product should be genuinely useful and competitive with free ALPR-awareness tools rather than an intentionally crippled demo.
- **Paid / Pro:** broader surveillance and automated-enforcement intelligence, potentially including red-light cameras, speed cameras, traffic-monitoring cameras, other ALPR vendors, and additional reliably sourced fixed surveillance infrastructure.
- **Paid routing value:** where technically and commercially justified, Pro should allow users to understand and optimize routes across selected exposure categories rather than merely unlock additional dots on a map.
- **Conversion concept:** a free user may be told that additional surveillance/enforcement exposure exists along a route without exposing precise infrastructure locations; detailed classification and broader exposure intelligence can be part of Pro.

Do not assume consumers will pay simply for Flock avoidance when credible competitors provide that capability for free. Meaningful pricing should depend on demonstrating broader product value and validating willingness to pay.

Avoid major infrastructure capital commitments solely in anticipation of future demand. Prove technical differentiation and commercial demand before committing substantial capital to dedicated server hardware; rent or use usage-based infrastructure while validating the market when practical.

## Product-map safety

User-facing maps should not expose precise surveillance-infrastructure coordinates. Known infrastructure should be represented approximately rather than as exact targetable points. Confidence should be communicated visually without implying a false physical coverage area.
