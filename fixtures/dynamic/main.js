import('marked').then(({ marked }) => {
  document.body.innerHTML = String(marked.parse('# hi'))
})
