export default {
  plugins: [
    {
      name: 'boom',
      buildStart() {
        throw new Error('boom plugin ran')
      },
    },
  ],
}
