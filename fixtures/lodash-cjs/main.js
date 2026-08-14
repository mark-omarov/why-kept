import { debounce } from 'lodash'

document.body.textContent = String(debounce(() => {}, 100))
