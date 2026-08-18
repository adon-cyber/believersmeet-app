// Google Translate Dynamic Engine & Custom Sleek Navbar Selector
(function() {
    // 1. Inject Hidden Google Translate Element and Script into DOM if not present
    if (!document.getElementById('google_translate_element')) {
        const translateDiv = document.createElement('div');
        translateDiv.id = 'google_translate_element';
        translateDiv.style.display = 'none';
        document.body.appendChild(translateDiv);
    }

    // Define global callback expected by Google Translate
    window.googleTranslateElementInit = function() {
        if (window.google && window.google.translate && window.google.translate.TranslateElement) {
            new window.google.translate.TranslateElement({
                pageLanguage: 'en',
                includedLanguages: 'en,sw,lg,fr',
                autoDisplay: false
            }, 'google_translate_element');
        }
    };

    // Load Google Translate script if not already loaded
    if (!document.getElementById('google-translate-script')) {
        const script = document.createElement('script');
        script.id = 'google-translate-script';
        script.type = 'text/javascript';
        script.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
        document.head.appendChild(script);
    }

    // 2. Cookie helper functions for Google Translate (`googtrans`)
    function setTranslateCookie(lang) {
        // Google Translate reads the cookie named 'googtrans' with value like '/en/sw'
        const cookieValue = `/en/${lang}`;
        document.cookie = `googtrans=${cookieValue}; path=/; domain=${window.location.hostname}`;
        document.cookie = `googtrans=${cookieValue}; path=/;`;
    }

    function getTranslateCookie() {
        const match = document.cookie.match(new RegExp('(^| )googtrans=([^;]+)'));
        if (match) {
            const parts = match[2].split('/');
            return parts[parts.length - 1] || 'en';
        }
        return 'en';
    }

    // 3. Trigger translation change
    window.triggerAppTranslation = function(langCode) {
        if (!langCode) return;

        // Save preference
        localStorage.setItem('app_language', langCode);

        // Set Google Translate cookie
        const domain = window.location.hostname;
        document.cookie = `googtrans=/en/${langCode}; path=/; domain=${domain}`;
        document.cookie = `googtrans=/en/${langCode}; path=/;`;

        // Trigger iframe select if google element exists
        const gtCombo = document.querySelector('.goog-te-combo');
        if (gtCombo) {
            gtCombo.value = langCode;
            gtCombo.dispatchEvent(new Event('change'));
        } else {
            // Fallback reload to apply cookie translation across all nodes
            location.reload();
        }
    };
    window.changeLanguage = window.triggerAppTranslation;

    // Auto-apply saved language choice on page load
    document.addEventListener('DOMContentLoaded', () => {
        const savedLang = localStorage.getItem('app_language') || 'en';
        const selectEl = document.getElementById('appLanguageSelect');
        if (selectEl) selectEl.value = savedLang;

        // Ensure cookie matches saved preference
        if (savedLang !== 'en') {
            const domain = window.location.hostname;
            document.cookie = `googtrans=/en/${savedLang}; path=/; domain=${domain}`;
            document.cookie = `googtrans=/en/${savedLang}; path=/;`;
        }
    });

    // 4. Inject Sleek Custom Language Selector Widget into Navbars
    function injectTranslateSelector() {
        // Find theme toggles across any navbar implementation
        const themeToggles = document.querySelectorAll('button[onclick*="toggleTheme"], button[onclick*="window.toggleTheme"]');
        
        themeToggles.forEach(toggleBtn => {
            const navContainer = toggleBtn.closest('div');
            if (!navContainer) return;

            // Check if translate selector already exists in this container
            if (navContainer.querySelector('#custom-translate-container')) return;

            const currentLang = getTranslateCookie();

            const translateContainer = document.createElement('div');
            translateContainer.id = 'custom-translate-container';
            translateContainer.className = 'ms-auto me-2 flex-shrink-0';
            translateContainer.innerHTML = `
                <select id="appLanguageSelect" class="form-select form-select-sm bg-dark text-white border-secondary" style="width: auto; cursor: pointer;" onchange="triggerAppTranslation(this.value)">
                    <option value="en" ${currentLang === 'en' ? 'selected' : ''}>🇬🇧 English</option>
                    <option value="sw" ${currentLang === 'sw' ? 'selected' : ''}>🇰🇪 Kiswahili</option>
                    <option value="lg" ${currentLang === 'lg' ? 'selected' : ''}>🇺🇬 Luganda</option>
                    <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>🇫🇷 Français</option>
                </select>
            `;

            // Insert before the theme toggle button
            navContainer.insertBefore(translateContainer, toggleBtn);
        });
    }

    // Run injector when DOM is ready or when navigation renders
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(injectTranslateSelector, 300);
        });
    } else {
        setTimeout(injectTranslateSelector, 300);
    }

    // Also observe DOM changes for dynamic navs like js/nav.js
    const observer = new MutationObserver(() => {
        injectTranslateSelector();
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
