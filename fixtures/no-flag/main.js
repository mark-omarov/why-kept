import { marked } from 'marked'

document.body.innerHTML = String(marked.parse('# hello'))
