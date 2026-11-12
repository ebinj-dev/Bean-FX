#!/bin/bash
agent-browser eval "var el = [...document.querySelectorAll('span')].find(s => s.getAttribute('aria-label') === 'Current playhead position'); el ? el.textContent : 'NOT-FOUND'" 2>/dev/null | tail -1
