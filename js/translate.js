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

    // 1. Trigger translation via cookie + forced clean reload
    window.triggerAppTranslation = function(langCode) {
      if (!langCode) return;

      // Save selected language to storage
      localStorage.setItem('app_language', langCode);

      // Clear existing googtrans cookies across paths and domains
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + window.location.hostname;
      const hostParts = window.location.hostname.split('.');
      if (hostParts.length > 1) {
          const baseDomain = hostParts.slice(-2).join('.');
          document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=." + baseDomain;
      }

      // Set new translation cookie if non-English
      if (langCode !== 'en') {
        document.cookie = "googtrans=/en/" + langCode + "; path=/;";
        document.cookie = "googtrans=/en/" + langCode + "; path=/; domain=" + window.location.hostname;
      }

      // Force page reload so Google Translate translates the entire DOM
      window.location.reload();
    };
    window.changeLanguage = window.triggerAppTranslation;

    // 2. Sync selector state on page load
    document.addEventListener('DOMContentLoaded', () => {
      const savedLang = localStorage.getItem('app_language') || 'en';
      const selectEl = document.getElementById('appLanguageSelect');
      if (selectEl) {
        selectEl.value = savedLang;
      }

      // Also ensure cookie matches saved preference
      if (savedLang !== 'en') {
        const domain = window.location.hostname;
        document.cookie = `googtrans=/en/${savedLang}; path=/; domain=${domain}`;
        document.cookie = `googtrans=/en/${savedLang}; path=/;`;
      }
    });

    // Helper to get current translate cookie
    function getTranslateCookie() {
        const match = document.cookie.match(new RegExp('(^| )googtrans=([^;]+)'));
        if (match) {
            const parts = match[2].split('/');
            return parts[parts.length - 1] || 'en';
        }
        return localStorage.getItem('app_language') || 'en';
    }

    // 4. Inject Sleek Custom Language Selector Widget into Navbars
    function injectTranslateSelector() {
        // Find theme toggles across any navbar implementation
        const themeToggles = document.querySelectorAll('button[onclick*="toggleTheme"], button[onclick*="window.toggleTheme"]');
        
        themeToggles.forEach(toggleBtn => {
            const navContainer = toggleBtn.closest('div');
            if (!navContainer) return;

            // Check if translate selector already exists in this container
            if (navContainer.querySelector('#appLanguageSelect')) return;

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
