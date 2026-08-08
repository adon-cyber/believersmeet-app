const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));

files.forEach(filename => {
    let content = fs.readFileSync(filename, 'utf8');

    // 1. Remove Tailwind CDN scripts and old Tailwind CDN links
    content = content.replace(/<script\s+src="https:\/\/cdn\.tailwindcss\.com"[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<script\s+src="https:\/\/cdn\.tailwindcss\.com"[^>]*\/?>/gi, '');
    content = content.replace(/<link[^>]*href="[^"]*tailwindcss[^"]*"[^>]*>/gi, '');

    // 2. Ensure css/style.css is inside <head>
    if (!content.includes('css/style.css') && !content.includes('style.css')) {
        if (content.includes('</head>')) {
            content = content.replace('</head>', '    <link rel="stylesheet" href="css/style.css">\n</head>');
        }
    } else if (content.includes('href="style.css"') && !content.includes('href="css/style.css"')) {
        content = content.replace('href="style.css"', 'href="css/style.css"');
    }

    // 3. Wrap central content/form container in <div class="glass-card floating-card"> on main pages/forms
    if (['index.html', 'login.html', 'signup.html', 'register-church.html', 'feed.html', 'forgot-password.html', 'reset-password.html', 'join-church.html'].includes(filename)) {
        // Find main container or form and ensure it has glass-card floating-card
        content = content.replace(/(class="[^"]*)(max-w-[^"]*)/g, '$1glass-card floating-card $2');
    }

    fs.writeFileSync(filename, content, 'utf8');
});

console.log('Successfully updated all HTML files.');
