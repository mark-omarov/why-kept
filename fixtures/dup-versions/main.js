import { marked } from 'marked'
import { marked as legacy } from 'marked14'

document.body.innerHTML = String(marked.parse('# new')) + String(legacy.parse('# old'))
