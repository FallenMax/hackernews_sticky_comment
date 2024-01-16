type Rect = {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

let isDebugging = (localStorage.getItem('debug') ?? '').startsWith('sticky')

// A hacker news user script that makes the comments sticky
const app = {
  util: {
    dom: {
      $$(selector: string, context: Element | undefined = document as any) {
        return Array.from(context.querySelectorAll(selector)) as HTMLElement[]
      },
      $(selector: string, context: Element | undefined = document as any) {
        return context.querySelector(selector) ?? (undefined as HTMLElement | undefined)
      },
    },
    logger: isDebugging ? console.log : () => {},
  },
  detect: {
    getPageBackgroundColor(): string {
      const $main = app.util.dom.$('#hnmain')
      return window.getComputedStyle($main!).backgroundColor
    },
  },
  // measure original position of elements (as if page was not scrolled and no css was applied)
  measurements: {
    _cache: new WeakMap<HTMLElement, Rect>(),
    onChange: new Set<() => void>(),
    initialize() {
      window.addEventListener('resize', () => {
        this.invalidate()
      })
      app.comments.onChange.add(() => {
        this.invalidate()
      })
    },
    invalidate() {
      this._cache = new WeakMap()
      this.onChange.forEach((fn) => fn())
      app.util.logger('measurements: invalidate')
    },
    getOriginalRect($tr: HTMLElement) {
      let cached = this._cache.get($tr)
      if (!cached) {
        let $measure = $tr.previousElementSibling as HTMLElement
        if (!$measure || !$measure.classList.contains('measure')) {
          $measure = document.createElement('tr')
          $measure.className = 'measure'
          $tr.parentElement!.insertBefore($measure, $tr)
        }

        let { left, width, height, right } = $tr.getBoundingClientRect()
        let { top } = $measure.getBoundingClientRect()
        const scrollY = window.scrollY
        top += scrollY
        const bottom = top + height
        cached = { top, left, width, height, right, bottom }
        this._cache.set($tr, cached)
      }
      return cached
    },
  },
  // comment tree structure
  comments: {
    _children: new WeakMap<HTMLElement, HTMLElement[]>(),
    _roots: [] as HTMLElement[],
    onChange: new Set<() => void>(),
    initialize() {
      this.buildTree()

      const $tbody = app.util.dom.$('table.comment-tree > tbody')

      // Monitor new/removed comments
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement && node.classList.contains('athing')) {
              this.buildTree()
              break
            }
          }
          for (const node of mutation.removedNodes) {
            if (node instanceof HTMLElement && node.classList.contains('athing')) {
              this.buildTree()
              break
            }
          }
        }
      })
      observer.observe($tbody!, { childList: true })

      // Monitor fold/unfold
      document.addEventListener(
        'click',
        (e) => {
          const $target = e.target as HTMLElement
          if ($target.classList.contains('togg')) {
            setTimeout(() => {
              this.buildTree()
            }, 300)
          }
        },
        { capture: true },
      )
    },
    buildTree() {
      app.util.logger('comments: build')

      this._roots = []
      this._children = new WeakMap()

      const $comments = this.getVisibleComments()
      let stack: HTMLElement[] = []
      const stackTop = (): HTMLElement | undefined => stack[stack.length - 1]
      const curIndent = () => stack.length - 1

      for (const $comment of $comments) {
        const indent = this.getIndent($comment)
        // - X (0)
        //   - X (1)

        while (indent < curIndent() + 1 && curIndent() >= 0) {
          stack.pop()
        }

        console.assert(indent === curIndent() + 1, 'indent is not correct')

        const top = stackTop()
        if (!top) {
          // phantom top, consider it a root
          this._roots.push($comment)
          stack.push($comment)
        } else {
          const children = this._children.get(top) ?? []
          children.push($comment)
          this._children.set(top, children)
          stack.push($comment)
        }
      }

      // Notify
      this.onChange.forEach((fn) => fn())
    },
    // root comment has indent=0
    getIndent(tr: HTMLElement): number {
      const $ = app.util.dom.$
      const td = $('td.ind', tr)
      console.assert(!!td, 'indent element not found')
      const indent = Number(td!.getAttribute('indent'))
      console.assert(!Number.isNaN(indent), 'indent is not a number')
      return indent
    },
    getRootComments(): HTMLElement[] {
      return this._roots
    },
    getChildren(item: HTMLElement): HTMLElement[] {
      return this._children.get(item) ?? []
    },
    getVisibleComments() {
      const $ = app.util.dom.$
      const $$ = app.util.dom.$$
      const $table = $('table.comment-tree')
      console.assert(!!$table, 'root element not found')
      const $comments = $$('tr.athing.comtr', $table).filter(($tr) => {
        // hidden children
        if ($tr.classList.contains('noshow')) {
          return false
        }
        // collapsed
        if ($tr.classList.contains('coll')) {
          return false
        }

        return true
      })
      return $comments
    },
  },
  // sticky calculations
  sticky: {
    _sticky: new Map<HTMLElement, number>(), // top
    _stickyList: [] as HTMLElement[],
    STICKY_CLASS: 'is-sticky',
    PUSHED_CLASS: 'is-pushed',
    getStickyTop(item: HTMLElement) {
      return this._sticky.get(item)
    },
    initialize() {
      // Inject CSS
      document.head.insertAdjacentHTML(
        'beforeend',
        `
<style>
tr.comtr.is-sticky {
	position: sticky;
	box-shadow: rgba(0, 0, 0, 0.15) 0px 0 8px 0px;
	background-color: ${app.detect.getPageBackgroundColor()};
}
tr.comtr.is-sticky.is-pushed {
	box-shadow: none;
}
</style>`,
      )

      // Adjust table style: border-collapse: collapse
      const $table = app.util.dom.$('table.comment-tree') as HTMLTableElement
      $table!.style.borderCollapse = 'collapse'

      // Update on scroll
      window.addEventListener(
        'scroll',
        () => {
          this.update()
        },
        { passive: true },
      )
      window.addEventListener(
        'resize',
        () => {
          this.update()
        },
        { passive: true },
      )

      // Initial update
      this.update()

      // Subscribe
      app.comments.onChange.add(() => {
        this.update()
      })
      app.measurements.onChange.add(() => {
        this.update()
      })
    },
    update() {
      const oldStickyList = this._stickyList

      // Calculate new sticky
      this._stickyList = []
      this._sticky = new Map()
      const rootComments = app.comments.getRootComments()
      this._stack(rootComments, window.scrollY)

      // Revert old sticky
      for (const item of oldStickyList) {
        if (!this._sticky.has(item)) {
          item.classList.remove(this.STICKY_CLASS)
          item.classList.remove(this.PUSHED_CLASS)
          item.style.top = ''
          item.style.zIndex = ''
        }
      }
    },
    makeSticky(item: HTMLElement, top: number, isPushed: boolean) {
      item.style.top = top + 'px'
      const indent = app.comments.getIndent(item)
      item.style.zIndex = String(100 - indent)
      item.classList.add(this.STICKY_CLASS) // To allow third party custom styling
      if (isPushed) {
        item.classList.add(this.PUSHED_CLASS)
      } else {
        item.classList.remove(this.PUSHED_CLASS)
      }

      this._sticky.set(item, top)
      this._stickyList.push(item)
    },
    _stack(items: HTMLElement[], scrollY: number, pusher?: HTMLElement, holder?: HTMLElement) {
      const ITEM_GAP = 0
      // Find node (holder) that should be made "sticky": last node with top edge < holder bottom or view top: Holder
      let visibleTop = 0
      if (holder) {
        const height = app.measurements.getOriginalRect(holder).height
        const top = app.sticky.getStickyTop(holder)
        if (top != null) {
          visibleTop = top + height + ITEM_GAP
        }
      }

      // Find the node (pusher) that will "push" the sticky node up
      const nextPusherIndex = items.findIndex((item) => {
        const rect = app.measurements.getOriginalRect(item)
        return rect.top - scrollY > visibleTop
      })
      const nextPusher = items[nextPusherIndex] ?? pusher
      const nextHolder = nextPusherIndex === -1 ? items[items.length - 1] : items[nextPusherIndex - 1]
      // Fast path: if nextPush is above visibleTop, we don't need to do anything
      if (nextPusher) {
        if (app.measurements.getOriginalRect(nextPusher).top - scrollY < visibleTop) {
          return
        }
      }
      if (nextHolder) {
        const r = app.measurements.getOriginalRect(nextHolder)
        let top = r.top - scrollY
        top = Math.max(visibleTop, top)
        // push up if necessary
        let isPushed = false
        if (nextPusher) {
          const nextPusherTop = app.measurements.getOriginalRect(nextPusher).top - scrollY
          if (nextPusherTop - r.height < top) {
            top = nextPusherTop - r.height
            isPushed = true
          }
        }
        if (top !== r.top - scrollY) {
          this.makeSticky(nextHolder, top, isPushed)
        }
        const children = app.comments.getChildren(nextHolder)
        if (children.length) {
          this._stack(children, scrollY, nextPusher, nextHolder)
        }
      }
    },
  },
  initialize() {
    app.measurements.initialize()
    app.comments.initialize()
    app.sticky.initialize()
  },
}

app.initialize()

if (isDebugging) {
  window.app = app
}
