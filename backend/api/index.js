let handler

try {
  handler = require('../dist/server.js')
} catch (error) {
  console.error('Failed to initialize backend:', error)
  handler = (_req, res) => {
    res.status(500).json({
      code: 'BOOTSTRAP_ERROR',
      message: error instanceof Error ? error.message : 'Backend failed to initialize.',
    })
  }
}

module.exports = handler
