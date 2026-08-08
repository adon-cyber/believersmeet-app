import os
import re

html_files = [f for f in os.listdir('.') if f.endswith('.html')]

for filename in html_files:
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove Tailwind CDN scripts and old Tailwind CDN links
    # Matches <script src="https://cdn.tailwindcss.com">...</script> or self-closing/inline config
    content = re.sub(r'<script\s+src="https://cdn\.tailwindcss\.com"[^>]*>.*?</script>', '', content, flags=re.DOTALL | re.IGNORECASE)
    content = re.sub(r'<script\s+src="https://cdn\.tailwindcss\.com"[^/]*/?>', '', content, flags=re.IGNORECASE)
    
    # Matches tailwindcss cdn links like https://cdn.jsdelivr.net/npm/tailwindcss@.../dist/tailwind.min.css
    content = re.sub(r'<link[^>]*href="[^"]*tailwindcss[^"]*"[^>]*>', '', content, flags=re.IGNORECASE)

    # 2. Ensure css/style.css is inside <head>
    if 'css/style.css' not in content:
        # Insert before </head>
        if '</head>' in content:
            content = content.replace('</head>', '    <link rel="stylesheet" href="css/style.css">\n</head>')
        else:
            # fallback if no </head>
            pass

    # 3. Wrap central content/form container in <div class="glass-card floating-card"> if not already wrapped or for login/signup/register/index/etc.
    # Let's target specific main form containers or main wrappers if they are authentication or central forms/cards.
    # For example, forms or max-w containers that act as cards.
    if filename in ['login.html', 'signup.html', 'forgot-password.html', 'reset-password.html', 'register-church.html', 'join-church.html']:
        # Wrap the main card/form container
        # Usually they have class containing max-w or similar inside body
        content = re.sub(r'(<div[^>]*class="[^"]*max-w-[^"]*)"([^>]*)>', r'<div class="glass-card floating-card \1"\2>', content)

    with open(filename, 'w', encoding='utf-8') as f:
        f.write(content)

print("Processed all HTML files successfully.")
