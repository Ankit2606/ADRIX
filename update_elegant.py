import re

with open("src/lib/styles.css", "r") as f:
    css = f.read()

# 1. Update fonts
fonts = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');\n"
css = re.sub(r'@import url[^;]+;\n', fonts, css, count=1)

# 2. Update :root variables (Dark & Elegant)
root_dark = """:root {
  --ink: #0a0a0a;
  --surface: #111111;
  --surface-2: #161616;
  --line: #2a2a2a;
  --line-soft: #1e1e1e;
  --text: #F3F4F6;
  --muted: #9CA3AF;
  --faint: #4B5563;
  --accent: #D4AF37;
  --accent-dim: rgba(212, 175, 55, 0.15);
  --warn: #FBBF24;
  --danger: #EF4444;
  --good: #10B981;
  --cta: #D4AF37;
  --cta-dim: rgba(212, 175, 55, 0.15);
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --serif: "Playfair Display", Georgia, Cambria, "Times New Roman", Times, serif;
}"""

root_light = """:root[data-theme='light'] {
  --ink: #FFFFFF;
  --surface: #F9FAFB;
  --surface-2: #F3F4F6;
  --line: #E5E7EB;
  --line-soft: #F3F4F6;
  --text: #111827;
  --muted: #4B5563;
  --faint: #9CA3AF;
  --accent: #B8860B;
  --accent-dim: rgba(184, 134, 11, 0.1);
  --warn: #D97706;
  --danger: #DC2626;
  --good: #059669;
  --cta: #111827;
  --cta-dim: rgba(17, 24, 39, 0.1);
}"""

css = re.sub(r':root\s*\{[^}]+\}', root_dark, css, count=1)
css = re.sub(r':root\[data-theme=\'light\'\]\s*\{[^}]+\}', root_light, css, count=1)

# 3. Body background
body_repl = """body {
  margin: 0;
  width: 380px;
  height: 600px;
  overflow: hidden;
  background: var(--ink);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}"""
css = re.sub(r'body\s*\{[^}]+\}', body_repl, css, count=1)

# 4. Card
card_repl = """.card {
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}"""
css = re.sub(r'\.card\s*\{[^}]+\}', card_repl, css)

# 5. Buttons (Luxury style)
buttons_css = """.primary {
  background: var(--accent);
  color: #000;
  border: 1px solid var(--accent);
  border-radius: 2px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-size: 12px;
  transition: all 0.3s ease;
}

.primary:hover:not(:disabled) {
  background: transparent;
  color: var(--accent);
}

.ghost {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 2px;
  font-weight: 500;
  letter-spacing: 0.02em;
  transition: all 0.3s ease;
}

.ghost:hover:not(:disabled) {
  border-color: var(--muted);
  color: var(--text);
}"""

# Remove old buttons
css = re.sub(r'\.primary\s*\{[^}]+\}', '', css)
css = re.sub(r'\.primary:hover:not\(:disabled\)\s*\{[^}]+\}', '', css)
css = re.sub(r'\.ghost\s*\{[^}]+\}', '', css)
css = re.sub(r'\.ghost:hover:not\(:disabled\)\s*\{[^}]+\}', '', css)
css += "\n" + buttons_css + "\n"

# 6. Inputs & Tabs
tabs_repl = """.tabs {
  display: flex;
  gap: 0;
  background: transparent;
  border-bottom: 1px solid var(--line);
  padding: 0;
}

.tabs button {
  flex: 1;
  padding: 12px 4px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  background: transparent;
  color: var(--muted);
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  transition: all 0.3s ease;
}

.tabs button[aria-selected='true'] {
  color: var(--accent);
  border-bottom-color: var(--accent);
}"""

css = re.sub(r'\.tabs\s*\{[^}]+\}', '', css)
css = re.sub(r'\.tabs button\s*\{[^}]+\}', '', css)
css = re.sub(r'\.tabs button\[aria-selected=\'true\'\]\s*\{[^}]+\}', '', css)
css += "\n" + tabs_repl + "\n"

# 7. Balance (Playfair Display for elegant look)
balance_repl = """.balance {
  font-family: var(--serif);
  font-size: 46px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--text);
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.balance span {
  font-family: var(--sans);
  font-size: 16px;
  color: var(--accent);
  letter-spacing: 0.05em;
  font-weight: 300;
}"""

css = re.sub(r'\.balance\s*\{[^}]+\}', '', css)
css = re.sub(r'\.balance span\s*\{[^}]+\}', '', css)
css += "\n" + balance_repl + "\n"

# 8. Topbar
topbar_repl = """.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  background: var(--ink);
  border-bottom: 1px solid var(--line);
}"""
css = re.sub(r'\.topbar\s*\{[^}]+\}', topbar_repl, css)

# 9. Item hover
item_repl = """.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  background: transparent;
  border-left: none;
  border-right: none;
  border-top: none;
  width: 100%;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.item:last-child {
  border-bottom: none;
}

.item:hover {
  background: var(--surface);
}"""
css = re.sub(r'\.item\s*\{[^}]+\}', '', css)
css = re.sub(r'\.item:last-child\s*\{[^}]+\}', '', css)
css = re.sub(r'\.item:hover\s*\{[^}]+\}', '', css)
css += "\n" + item_repl + "\n"

# Additional luxury touches: square borders, elegant chip
extras = """
.chip {
  border-radius: 2px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-family: var(--sans);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.eyebrow {
  font-family: var(--sans);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--muted);
}
"""
css += extras

with open("src/lib/styles.css", "w") as f:
    f.write(css)

print("Updated CSS successfully!")
