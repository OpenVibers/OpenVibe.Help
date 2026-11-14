'use strict';
// The ticket form's site picker: search the sites by name or domain, show the picked site's own icon and name in
// the field, and close the sheet on a pick. The page works without this (the details sheet, its radios and the
// form are plain HTML); this only makes the search and the field's summary live.
(function () {
    var picker = document.querySelector('.site-pick');
    if (!picker) return;
    var search = picker.querySelector('#site-search');
    var list = picker.querySelector('.site-pick-list');
    var empty = picker.querySelector('.site-pick-empty');
    var summary = picker.querySelector('.site-pick-summary');
    var currentIcon = picker.querySelector('.site-pick-current-icon');
    var currentName = picker.querySelector('[data-site-name]');
    var currentDomain = picker.querySelector('[data-site-domain]');
    var rows = Array.prototype.slice.call(picker.querySelectorAll('.site-pick-row'));

    // Every term must appear in the row's name or domain (data-search holds both, lower case).
    function filter() {
        var terms = String(search.value || '').toLowerCase().split(/\s+/).filter(Boolean);
        var shown = 0;
        rows.forEach(function (row) {
            var hay = row.getAttribute('data-search') || '';
            var match = terms.every(function (term) { return hay.indexOf(term) !== -1; });
            row.hidden = !match;
            if (match) shown++;
        });
        if (empty) empty.hidden = shown !== 0;
    }

    // The field above the sheet: the picked row's icon and name, or "Not about one site".
    function summarize(input) {
        if (!input || !input.value) {
            if (currentIcon) currentIcon.textContent = '';
            if (currentName) currentName.textContent = 'Not about one site';
            if (currentDomain) { currentDomain.textContent = ''; currentDomain.hidden = true; }
            return;
        }
        var row = input.closest('.site-pick-row');
        if (!row) return;
        var icon = row.querySelector('.ov-appicon');
        var name = row.querySelector('.site-pick-name');
        var domain = row.querySelector('.site-pick-domain');
        if (currentIcon) {
            currentIcon.textContent = '';
            if (icon) currentIcon.appendChild(icon.cloneNode(true));
        }
        if (currentName) currentName.textContent = name ? name.textContent : '';
        if (currentDomain) {
            currentDomain.textContent = domain ? domain.textContent : '';
            currentDomain.hidden = false;
        }
    }

    function close() {
        picker.open = false;
        // The next open starts from the whole list, never from the search that picked this site.
        if (search) { search.value = ''; filter(); }
        if (summary) summary.focus();
    }

    search.addEventListener('input', filter);
    picker.addEventListener('change', function (e) {
        if (!e.target || e.target.name !== 'site') return;
        summarize(e.target);
        close();
    });
    picker.addEventListener('toggle', function () {
        if (!picker.open) return;
        filter();
        var checked = picker.querySelector('.site-pick-row > input:checked');
        if (checked && list) {
            var row = checked.closest('.site-pick-row');
            list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - 6);
        }
    });
    picker.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && picker.open) { close(); e.stopPropagation(); }
    });
    document.addEventListener('click', function (e) {
        if (picker.open && !picker.contains(e.target)) picker.open = false;
    });
})();
