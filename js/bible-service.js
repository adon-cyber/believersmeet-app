/**
 * js/bible-service.js
 * Standalone Bible Reference Auto-Linker and Verse Viewer Service
 * Uses https://bible-api.com
 */

(function () {
    // 1. Linkify Bible References Regex & Function
    // Matches references like "John 3:16", "1 John 3:16", "Genesis 1:1-5", "2 Corinthians 5:17", "Psalm 23", "Song of Solomon 2:1"
    const BIBLE_REF_REGEX = /\b((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)(?::(\d+)(?:–\d+|-\d+)?)?\b/g;

    function linkifyBibleReferences(text) {
        if (!text || typeof text !== 'string') return '';

        // To avoid replacing inside existing HTML tags or attributes, we can tokenize or replace safely.
        // If text contains HTML tags (like <p>, <b>, etc.), we should be careful not to corrupt them.
        // A robust approach for plain text or escaped text:
        return text.replace(BIBLE_REF_REGEX, (match, book, chapter, verse) => {
            // Verify it looks like a valid book name or general scripture reference
            const cleanRef = match.trim();
            return `<a class="bible-link text-indigo-600 font-semibold hover:underline cursor-pointer" data-ref="${encodeURIComponent(cleanRef)}">${cleanRef}</a>`;
        });
    }

    window.linkifyBibleReferences = linkifyBibleReferences;

    // 2. Dynamic Modal Injection into DOM
    function injectBibleModal() {
        if (document.getElementById('bible-modal')) return;

        const modalHTML = `
            <div id="bible-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm hidden" aria-modal="true" role="dialog">
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden transform transition-all animate-fade-in-up">
                    <!-- Modal Header -->
                    <div class="flex items-center justify-between px-6 py-4 bg-indigo-600 text-white">
                        <div class="flex items-center space-x-2">
                            <span class="text-xl">📖</span>
                            <h3 id="bible-modal-title" class="text-lg font-bold">Scripture Reference</h3>
                        </div>
                        <button id="bible-modal-close" class="text-white hover:text-indigo-200 text-2xl font-bold focus:outline-none">&times;</button>
                    </div>

                    <!-- Modal Body -->
                    <div id="bible-modal-body" class="p-6 max-h-[60vh] overflow-y-auto text-gray-800 text-base leading-relaxed">
                        <div class="flex flex-col items-center justify-center py-8 space-y-3">
                            <div class="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                            <p class="text-sm text-gray-500 font-medium">Fetching scripture from Bible API...</p>
                        </div>
                    </div>

                    <!-- Modal Footer -->
                    <div class="px-6 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                        <span id="bible-modal-translation">World English Bible (WEB)</span>
                        <a id="bible-modal-youversion" href="#" target="_blank" class="text-indigo-600 hover:text-indigo-800 font-semibold hidden">View on YouVersion &rarr;</a>
                    </div>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = modalHTML;
        document.body.appendChild(div.firstElementChild);

        // Wire up close events
        const modal = document.getElementById('bible-modal');
        const closeBtn = document.getElementById('bible-modal-close');

        closeBtn.addEventListener('click', closeBibleModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeBibleModal();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
                closeBibleModal();
            }
        });
    }

    function openBibleModal(reference) {
        injectBibleModal();
        const modal = document.getElementById('bible-modal');
        const titleEl = document.getElementById('bible-modal-title');
        const bodyEl = document.getElementById('bible-modal-body');
        const transEl = document.getElementById('bible-modal-translation');
        const youversionEl = document.getElementById('bible-modal-youversion');

        titleEl.textContent = reference;
        bodyEl.innerHTML = `
            <div class="flex flex-col items-center justify-center py-8 space-y-3">
                <div class="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                <p class="text-sm text-gray-500 font-medium">Fetching ${reference}...</p>
            </div>
        `;
        youversionEl.classList.add('hidden');
        modal.classList.remove('hidden');

        // Fetch verse via bible-api.com
        fetch(`https://bible-api.com/${encodeURIComponent(reference)}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to fetch scripture. Please check reference.');
                return res.json();
            })
            .then(data => {
                transEl.textContent = data.translation_name || 'World English Bible';
                
                if (data.verses && data.verses.length > 0) {
                    const versesHtml = data.verses.map(v => `
                        <p class="mb-2">
                            <sup class="text-indigo-600 font-bold mr-1">${v.verse}</sup>${v.text.trim()}
                        </p>
                    `).join('');
                    bodyEl.innerHTML = `
                        <div class="space-y-2">
                            <h4 class="text-sm font-bold text-indigo-700 mb-3">${data.reference} (${data.translation_name || 'WEB'})</h4>
                            ${versesHtml}
                        </div>
                    `;
                } else if (data.text) {
                    bodyEl.innerHTML = `
                        <div class="space-y-2">
                            <h4 class="text-sm font-bold text-indigo-700 mb-3">${data.reference}</h4>
                            <p>${data.text.trim()}</p>
                        </div>
                    `;
                } else {
                    bodyEl.innerHTML = `<p class="text-red-500 text-center py-4">No verse text found for "${reference}".</p>`;
                }

                // Optional YouVersion search link
                youversionEl.href = `https://www.bible.com/search/bible?q=${encodeURIComponent(reference)}`;
                youversionEl.classList.remove('hidden');
            })
            .catch(err => {
                console.error("Bible API error:", err);
                bodyEl.innerHTML = `
                    <div class="text-center py-6 space-y-2">
                        <p class="text-red-600 font-semibold">Could not load scripture reference.</p>
                        <p class="text-xs text-gray-500">Please check your internet connection or try a standard reference (e.g., John 3:16).</p>
                    </div>
                `;
            });
    }

    function closeBibleModal() {
        const modal = document.getElementById('bible-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    // 3. Global Event Delegation for Bible Links
    document.addEventListener('DOMContentLoaded', () => {
        injectBibleModal();

        document.body.addEventListener('click', (e) => {
            const bibleLink = e.target.closest('.bible-link');
            if (bibleLink) {
                e.preventDefault();
                const encodedRef = bibleLink.getAttribute('data-ref');
                if (encodedRef) {
                    const reference = decodeURIComponent(encodedRef);
                    openBibleModal(reference);
                }
            }
        });
    });

    window.openBibleModal = openBibleModal;
})();
