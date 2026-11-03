// Shared Master Footer Component Script
(function() {
    document.addEventListener("DOMContentLoaded", function() {
        // Find existing footer or create placeholder if needed
        let footerEl = document.querySelector('footer');
        const masterFooterHtml = `
            <footer class="bg-slate-900 border-t border-slate-800/80 py-12 text-slate-400 font-sans mt-auto">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
                    <!-- Top Footer Section: Rich Responsive Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-center text-center md:text-left">
                        <!-- Left: Logo, Tagline, & Mission -->
                        <div class="space-y-3">
                            <div class="flex items-center justify-center md:justify-start space-x-2">
                                <img src="images/BELIEVERS.LOGO.png" alt="Logo" class="w-9 h-9 rounded-full object-cover border border-white/20 shadow">
                                <span class="text-white font-bold text-lg tracking-tight">BelieversMeet</span>
                            </div>
                            <p class="text-slate-400 text-xs sm:text-sm">Connecting believers, empowering churches, and strengthening faith communities worldwide.</p>
                        </div>

                        <!-- Right: Support / Terms & Social / Contact Links -->
                        <div class="flex flex-col items-center md:items-end space-y-2 text-sm">
                            <div class="flex items-center space-x-4">
                                <a href="about-developer.html" class="text-slate-400 hover:text-blue-400 transition text-xs sm:text-sm underline">About Developer</a>
                                <a href="mailto:adoniakasango@gmail.com" class="text-slate-400 hover:text-white transition text-xs sm:text-sm">Support</a>
                            </div>
                            <div class="flex items-center space-x-3 text-slate-400 pt-1">
                                <a href="https://wa.me/256777778443" target="_blank" rel="noopener noreferrer" class="hover:text-emerald-400 transition" title="WhatsApp">
                                    <i class="fab fa-whatsapp text-lg text-emerald-500"></i>
                                </a>
                                <a href="tel:+256751522766" class="hover:text-blue-400 transition" title="Call">
                                    <i class="fas fa-phone-alt text-sm text-blue-400"></i>
                                </a>
                            </div>
                        </div>
                    </div>

                    <!-- Bottom Bar: Standardized Copyright Row -->
                    <div class="border-t border-slate-800/80 pt-6 text-center text-xs text-slate-500 space-y-1">
                        <p>&copy; 2026 BelieversMeet. All rights reserved.</p>
                        <p>Building and strengthening faith communities together.</p>
                    </div>
                </div>
            </footer>
        `;

        if (footerEl) {
            footerEl.outerHTML = masterFooterHtml;
        } else {
            // Append before body closing tag if no footer found
            const newFooter = document.createElement('div');
            newFooter.innerHTML = masterFooterHtml;
            document.body.appendChild(newFooter.firstElementChild);
        }
    });
})();
