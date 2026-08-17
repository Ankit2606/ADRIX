import re

with open("src/lib/styles.css", "r") as f:
    css = f.read()

# 1. Add Google Fonts
fonts = "@import url('https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;500;600;700&family=Orbitron:wght@400;500;600;700&display=swap');\n"
if "@import" not in css:
    css = fonts + css

# 2. Replace :root and :root[data-theme='light']
root_dark = """:root {
  --ink: #050b14;
  --surface: rgba(15, 23, 42, 0.5);
  --surface-2: rgba(30, 41, 59, 0.5);
  --line: rgba(255, 255, 255, 0.1);
  --line-soft: rgba(255, 255, 255, 0.05);
  --text: #F8FAFC;
  --muted: #94A3B8;
  --faint: #475569;
  --accent: #F59E0B;
  --accent-dim: rgba(245, 158, 11, 0.15);
  --warn: #FBBF24;
  --danger: #EF4444;
  --good: #10B981;
  --cta: #8B5CF6;
  --cta-dim: rgba(139, 92, 246, 0.2);
  --mono: "Orbitron", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: "Exo 2", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.25);
  --glass-blur: blur(12px);
  --glass-border: 1px solid rgba(255, 255, 255, 0.1);
}"""

root_light = """:root[data-theme='light'] {
  --ink: #F1F5F9;
  --surface: rgba(255, 255, 255, 0.6);
  --surface-2: rgba(255, 255, 255, 0.8);
  --line: rgba(0, 0, 0, 0.1);
  --line-soft: rgba(0, 0, 0, 0.05);
  --text: #0F172A;
  --muted: #475569;
  --faint: #94A3B8;
  --accent: #D97706;
  --accent-dim: rgba(217, 119, 6, 0.15);
  --warn: #b7791f;
  --danger: #c24141;
  --good: #238a4f;
  --cta: #7C3AED;
  --cta-dim: rgba(124, 58, 237, 0.2);
  --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.1);
  --glass-border: 1px solid rgba(0, 0, 0, 0.05);
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
  background-image: 
    radial-gradient(circle at 15% 50%, rgba(139, 92, 246, 0.15), transparent 35%),
    radial-gradient(circle at 85% 30%, rgba(245, 158, 11, 0.12), transparent 35%);
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}"""
css = re.sub(r'body\s*\{[^}]+\}', body_repl, css, count=1)

# 4. Card
card_repl = """.card {
  background: var(--surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  box-shadow: var(--glass-shadow);
  border-radius: 16px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}"""
css = re.sub(r'\.card\s*\{[^}]+\}', card_repl, css)

# 5. Buttons
buttons_css = """.primary {
  background: linear-gradient(135deg, var(--cta), #7C3AED);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
}

.primary:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(139, 92, 246, 0.5);
  transform: translateY(-1px);
}

.ghost {
  background: var(--surface);
  border: var(--glass-border);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  color: var(--text);
}

.ghost:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--line);
  transform: translateY(-1px);
}"""

css = re.sub(r'\.primary\s*\{[^}]+\}', '', css)
css = re.sub(r'\.primary:hover:not\(:disabled\)\s*\{[^}]+\}', '', css)
css = re.sub(r'\.ghost\s*\{[^}]+\}', '', css)
css = re.sub(r'\.ghost:hover:not\(:disabled\)\s*\{[^}]+\}', '', css)
css += "\n" + buttons_css + "\n"

# 6. Inputs & Tabs
tabs_repl = """.tabs {
  display: flex;
  gap: 4px;
  background: var(--surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: 12px;
  padding: 6px;
}

.tabs button {
  flex: 1;
  padding: 8px;
  font-size: 13px;
  background: transparent;
  color: var(--muted);
  border: none;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.tabs button[aria-selected='true'] {
  background: var(--surface-2);
  color: var(--text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}"""

css = re.sub(r'\.tabs\s*\{[^}]+\}', '', css)
css = re.sub(r'\.tabs button\s*\{[^}]+\}', '', css)
css = re.sub(r'\.tabs button\[aria-selected=\'true\'\]\s*\{[^}]+\}', '', css)
css += "\n" + tabs_repl + "\n"

# 7. Balance
balance_repl = """.balance {
  font-family: var(--mono);
  font-size: 42px;
  font-weight: 600;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--text), var(--muted));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  display: flex;
  align-items: baseline;
  gap: 8px;
  text-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.balance span {
  font-size: 16px;
  -webkit-text-fill-color: var(--muted);
}"""

css = re.sub(r'\.balance\s*\{[^}]+\}', '', css)
css = re.sub(r'\.balance span\s*\{[^}]+\}', '', css)
css += "\n" + balance_repl + "\n"

# 8. Topbar
topbar_repl = """.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-bottom: var(--glass-border);
}"""
css = re.sub(r'\.topbar\s*\{[^}]+\}', topbar_repl, css)

# 9. Item hover
item_repl = """.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
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
  transition: all 0.2s ease;
  border-radius: 8px;
}

.item:last-child {
  border-bottom: none;
}

.item:hover {
  background: var(--surface-2);
  border-bottom-color: transparent;
}"""
css = re.sub(r'\.item\s*\{[^}]+\}', '', css)
css = re.sub(r'\.item:last-child\s*\{[^}]+\}', '', css)
css = re.sub(r'\.item:hover\s*\{[^}]+\}', '', css)
css += "\n" + item_repl + "\n"


with open("src/lib/styles.css", "w") as f:
    f.write(css)

print("Updated CSS successfully!")
