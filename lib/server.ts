import * as fs from 'fs'
import * as path from 'path'
import * as LRU from 'lru-cache'
import * as express from 'express'
import * as favicon from 'serve-favicon'
import * as compression from 'compression'
import * as microcache from 'route-cache'

import { setConfig, Config } from './config'

export function server(config?: Config): any {
    config = setConfig(config)

    const resolve = file => path.resolve(config.projectPath, file)

    const { createBundleRenderer } = require('vue-server-renderer')

    const isProd = process.env.NODE_ENV === 'production'
    const useMicroCache = process.env.MICRO_CACHE !== 'false'

    const app = express()

    function createRenderer(bundle, options) {
        // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
        return createBundleRenderer(
            bundle,
            Object.assign(options, {
                // for component caching
                cache: LRU({
                    max: 1000,
                    maxAge: 1000 * 60 * 15
                }),
                // this is only needed when vue-server-renderer is npm-linked
                basedir: resolve('./dist'),
                // recommended for performance
                runInNewContext: false
            })
        )
    }

    let renderer
    let readyPromise
    const templatePath = resolve(config.template)

    if (isProd) {
        // In production: create server renderer using template and built server bundle.
        // The server bundle is generated by vue-ssr-webpack-plugin.
        const template = fs.readFileSync(templatePath, 'utf-8')
        const bundle = require(resolve('./dist/vue-ssr-server-bundle.json'))
        // The client manifests are optional, but it allows the renderer
        // to automatically infer preload/prefetch links and directly add <script>
        // tags for any async chunks used during render, avoiding waterfall requests.
        const clientManifest = require(resolve(
            './dist/vue-ssr-client-manifest.json'
        ))
        renderer = createRenderer(bundle, {
            template,
            clientManifest
        })
    } else {
        // In development: setup the dev server with watch and hot-reload,
        // and create a new renderer on bundle / index template update.
        readyPromise = require('./config/setup-dev-server')(
            app,
            templatePath,
            (bundle, options) => {
                renderer = createRenderer(bundle, options)
            }
        )
    }

    const serve = (path, cache) =>
        express.static(resolve(path), {
            maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
        })

    app.use(compression({ threshold: 0 }))
    if (config.faviconURL) {
        app.use(favicon(config.faviconURL))
    }
    app.use('/dist', serve('./dist', true))
    app.use('/public', serve('./public', true))
    app.use('/manifest.json', serve('./manifest.json', true))
    app.use('/service-worker.js', serve('./dist/service-worker.js', false))

    // since this app has no user-specific content, every page is micro-cacheable.
    // if your app involves user-specific content, you need to implement custom
    // logic to determine whether a request is cacheable based on its url and
    // headers.
    // 1-second microcache.
    // https://www.nginx.com/blog/benefits-of-microcaching-nginx/
    app.use(microcache.cacheSeconds(1, req => useMicroCache && req.originalUrl))

    function render(req, res) {
        const s = Date.now()

        res.setHeader('Content-Type', 'text/html')

        const handleError = err => {
            if (err.url) {
                res.redirect(err.url)
            } else if (err.code === 404) {
                res.status(404).send(config.status404)
            } else {
                // Render Error Page or Redirect
                res.status(500).send(config.status500)
                console.error(`error during render : ${req.url}`)
                console.error(err.stack)
            }
        }

        return Promise.resolve(() => config.context(req)).then(context => {
            context = Object.assign(
                {
                    title: 'App', // default title
                    url: req.url
                },
                context
            )
            renderer.renderToString(context, (err, html) => {
                if (err) {
                    if (config.handleError) {
                        return config.handleError(err)
                    }
                    return handleError(err)
                }
                res.send(html)
                if (!isProd) {
                    console.log(`whole request: ${Date.now() - s}ms`)
                }
            })
        })
    }

    app.get(
        '*',
        isProd
            ? render
            : (req, res) => {
                  readyPromise.then(() => render(req, res))
              }
    )

    const port = config.port || process.env.PORT || 8080
    app.listen(port, () => {
        console.log(`server started at http://localhost:${port}`)
    })

    return app
}
