# 001 — Polish the theme toggle motion

- **Commit:** 3a4641190
- **Severity:** HIGH
- **Category:** Physicality & origin
- **Estimated scope:** 1 file, ~45 lines

## Problem

The theme toggle moves its own hover target upward by 2px with Tailwind's default transition timing. That movement can leave the pointer's hover boundary, feels abrupt in this compact dashboard header, and has no useful product purpose. The control is also visually large because its 44px accessibility target and its visible pill are the same box, and the text label misses the clearer Sun, Moon, and Monitor symbols already available from `lucide-react`.

## Where

| File                                       | Lines | What's there                                               |
| ------------------------------------------ | ----: | ---------------------------------------------------------- |
| `apps/www/src/components/theme-toggle.tsx` | 64–78 | Text-only 44px pill with a hover lift on the button itself |

### Current code

```tsx
const label =
  mode === "auto"
    ? "Theme mode: auto (system). Click to switch to light mode."
    : `Theme mode: ${mode}. Click to switch mode.`

return (
  <button
    type="button"
    onClick={toggleMode}
    aria-label={label}
    title={label}
    className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background/75 px-4 text-sm font-semibold text-foreground shadow-sm transition-[background-color,border-color,color,transform] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-0.5 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent"
  >
    {mode === "auto" ? "Auto" : mode === "dark" ? "Dark" : "Light"}
  </button>
)
```

## Target

Keep the existing `ThemeToggle` API and the `auto → light → dark → auto` behavior. Render a compact, icon-only 36px visible control with a 44px pseudo-element hit area. Use `Sun`, `Moon`, and `Monitor` from the already installed `lucide-react` package. Keep all three icons mounted and layer them in the same 16px box so CSS transitions can retarget cleanly when the button is clicked quickly.

Use these exact motion values:

```css
/* Visible 36px control; ::before expands the interactive area to 44px. */
.theme-toggle {
  position: relative;
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  touch-action: manipulation;
}

.theme-toggle::before {
  position: absolute;
  inset: -0.25rem;
  content: "";
}

/* Move/scale the visual child, never the hover target itself. */
.theme-toggle-visual {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9999px;
  color: var(--foreground);
  background: color-mix(in oklch, var(--background) 75%, transparent);
  box-shadow: var(--shadow-sm);
  transition:
    transform 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
    color 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease;
}

.theme-toggle:active .theme-toggle-visual {
  transform: scale(0.97);
}

.theme-toggle-icon {
  position: absolute;
  width: 1rem;
  height: 1rem;
  opacity: 0;
  transform: scale(0.82) rotate(-12deg);
  transition:
    opacity 140ms ease,
    transform 160ms cubic-bezier(0.645, 0.045, 0.355, 1);
}

.theme-toggle-icon[data-active="true"] {
  opacity: 1;
  transform: scale(1) rotate(0deg);
}

@media (hover: hover) and (pointer: fine) {
  .theme-toggle:hover .theme-toggle-visual {
    background-color: var(--accent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .theme-toggle-visual,
  .theme-toggle-icon,
  .theme-toggle-icon[data-active="true"] {
    transform: none;
  }
}
```

The implementation may express these rules with Tailwind utilities inside `theme-toggle.tsx`; do not add global selectors just to reproduce the snippet. The exact dimensions, properties, durations, curves, scale, and rotation above are the target.

The rendered structure should remain a semantic button:

```tsx
<button className="theme-toggle" aria-label={label} title={label} type="button">
  <span aria-hidden="true" className="theme-toggle-visual">
    <Sun className="theme-toggle-icon" data-active={mode === "light"} />
    <Moon className="theme-toggle-icon" data-active={mode === "dark"} />
    <Monitor className="theme-toggle-icon" data-active={mode === "auto"} />
  </span>
</button>
```

Set the accessible name to the current and next state, for example `Theme: auto. Switch to light.`. Keep every icon `aria-hidden` through the visual wrapper so assistive technology announces only the button label.

**Why these values:**

- 36px keeps the visible control smaller than the current 44px pill; the 4px pseudo-element on every side preserves a 44×44px pointer target.
- `scale(0.97)` and 150ms `cubic-bezier(0.25, 0.46, 0.45, 0.94)` provide press feedback that is felt rather than visibly collapsing.
- Hover changes only background color over 120ms `ease`; it does not move the pointer target.
- The layered icons use only `opacity` and `transform`, avoid layout shift, and retarget cleanly because they remain mounted.
- The 160ms `cubic-bezier(0.645, 0.045, 0.355, 1)` icon transform fits an on-screen state morph without making a high-frequency product control feel slow.
- Reduced motion removes scale and rotation while retaining the correct static state.

## Conventions to follow

- Use Tailwind classes and `cn` from `#/lib/utils`; do not create a CSS module for one small control.
- `apps/www/src/components/source-sync-island-mocks.tsx:96` is the local exemplar for a 150ms product-control transition, explicit transition properties, and a minimum 44px target.
- `apps/www/src/routes/app.tsx:267` and `apps/www/src/routes/app.tsx:273` use the dashboard's established custom cubic-bezier style.
- `lucide-react` is already a dependency of `apps/www`; do not add or update packages.
- CSS transitions are the right tool for this rapidly retargeted micro-interaction. Do not import `motion/react` for it.

## Steps

1. Import `Monitor`, `Moon`, and `Sun` from `lucide-react`, plus `cn` if conditional Tailwind classes need it.
2. Define the next mode once and reuse it in `toggleMode` and in the accessible label so the behavior and copy cannot drift.
3. Replace the text pill with the semantic icon button and three overlaid, `aria-hidden` icons.
4. Remove the hover translation completely. Apply hover background feedback only on fine pointers.
5. Put the 0.97 active scale on the inner visual span, not on the button's hit target.
6. Add a reduced-motion variant that removes icon rotation/scale and press scale.
7. Keep the current local-storage, system media-query, root class, `data-theme`, and `colorScheme` behavior unchanged.

## Out of scope

- Do not animate the page-wide theme change or add a View Transition wipe.
- Do not change the app header's compact/expanded animation.
- Do not change the mode order or replace the three-state control with a two-state switch.
- Do not introduce a new animation or icon library.
- Do not change any other component's timing, even if it looks similar.

## Verification

**Build**

- [ ] `mise x -- pnpm --filter www run build` passes.
- [ ] `mise x -- pnpm exec oxlint apps/www/src/components/theme-toggle.tsx` passes.
- [ ] `mise x -- pnpm exec oxfmt --check apps/www/src/components/theme-toggle.tsx` passes.

**Behavior**

- [ ] Clicking cycles `auto → light → dark → auto`; local storage and the root `light`/`dark` class match every state.
- [ ] The visible circle is 36×36px while its pseudo-element pointer hit area is 44×44px.
- [ ] Keyboard focus has a visible neutral focus ring, and Enter/Space changes the mode.
- [ ] The active icon always matches the current mode and causes no layout shift.
- [ ] Rapid clicks retarget the icon crossfade from its current position instead of restarting from a keyframe.
- [ ] With `prefers-reduced-motion: reduce` emulated, no icon rotates or scales and the active icon remains clear.

**Feel**

- [ ] Record hover, press, and two rapid clicks, then scrub frame by frame. Hover should stay planted; press should feel tactile but barely look smaller; the icon swap should read as one object changing state.
- [ ] Test with a mouse and a touch device. Touch must not leave a stuck hover state, and the 44px hit area must remain easy to tap.
- [ ] Look at it again with fresh eyes before calling it done.

## Notes

Whether 12 degrees of rotation reads as elegant or decorative cannot be decided from code alone. Feel-check it in both light and dark themes; if it draws attention away from the dashboard, keep the opacity crossfade and remove rotation rather than increasing duration.
