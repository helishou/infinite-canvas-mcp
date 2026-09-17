---
name: frontend-design
description: Design new web interfaces or deliberately redesign their visual presentation. Use for requested UI creation or visual polish, not routine React logic, interaction bug fixes, or small changes within an established design.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Scope and Existing Products

In an existing product, preserve its theme tokens, typography, component library, accessibility and interaction conventions unless the user requests a redesign. In this canvas project, follow the existing light/dark themes and flat visual style. A bug fix or adding a control is not authorization to change surrounding layout, fonts, colors or motion.

The creative directions below apply where the brief leaves design freedom. They are options, not requirements to add effects, dependencies or a new design system. Use the smallest implementation that fulfills the requested visual outcome.

## Design Thinking

Before coding, understand the context and choose a direction compatible with the brief and existing product:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: For a new visual direction, consider minimal, editorial, playful, organic, industrial or other styles suited to the audience. For an extension, inherit the established tone.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Preserve existing product fonts. For a new design, select legible fonts with appropriate language coverage and character; system fonts, Arial or Inter are valid when they fit the brief. Add font assets only when their benefit justifies them.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Add motion only when it improves feedback or supports the requested design. Reuse existing mechanisms, respect reduced-motion preferences and keep interactions responsive; animations and new libraries are not required for a polished result.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Use only details that support the chosen direction. Flat solid backgrounds are appropriate for restrained interfaces; textures, gradients, shadows and decorative effects are optional and must respect product conventions and performance.

Avoid context-free decorative defaults. Familiar components, standard layouts and existing typography are appropriate when they support usability and consistency.

For new concepts, make choices specific to the context. For related screens and iterations, consistency matters more than novelty; do not rotate themes or fonts merely to make each output different.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Stop when the requested interface or visual change is complete and appropriately checked. Do not add another redesign or unrelated polish pass solely to demonstrate creativity.
