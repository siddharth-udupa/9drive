import { app } from './app.js'
import { env } from './config/env.js'

export = app

if (!process.env.VERCEL) {
  const port = process.env.PORT ? Number(process.env.PORT) : env.APP_PORT
  app.listen(port, () => {
    console.log(`Backend running on port ${port}`)
  })
}
