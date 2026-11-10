/**
 * A broadcast queue with per-cursor positions, mirroring the semantics of
 * Rust's `tokio::sync::broadcast`.
 *
 * One publisher, many readers. Each reader holds an independent cursor so
 * multiple consumers attached to the same queue each see every event.
 * Readers created after a value has been published do not replay history —
 * they start at the next value.
 *
 * The buffer is bounded by `bufferLimit` (default 4096). When the buffer
 * fills, the oldest entries are dropped and laggard cursors are
 * fast-forwarded past the gap. Callers who must not drop events should
 * drain promptly or use a larger limit.
 *
 * @internal
 */
export class AsyncBroadcastQueue {
    buffer = [];
    /** Absolute logical position of `buffer[0]` (entries below have been dropped). */
    base = 0;
    cursors = new Set();
    closed = false;
    bufferLimit;
    constructor(bufferLimit = 4096) {
        this.bufferLimit = bufferLimit;
    }
    /** Whether the queue has been closed. New readers see immediate end-of-stream. */
    get isClosed() {
        return this.closed;
    }
    /** Whether at least one reader is attached. */
    get hasReaders() {
        return this.cursors.size > 0;
    }
    /** Publish a value to every attached reader. */
    publish(value) {
        if (this.closed)
            return;
        this.buffer.push(value);
        // Enforce the bounded buffer. If we exceed the limit, drop the
        // oldest entry and fast-forward any cursor that was still pointing
        // at it.
        if (this.buffer.length > this.bufferLimit) {
            const drop = this.buffer.length - this.bufferLimit;
            this.buffer.splice(0, drop);
            this.base += drop;
            for (const cursor of this.cursors) {
                if (cursor.position < this.base)
                    cursor.position = this.base;
            }
        }
        // Wake any cursor whose position is now valid.
        const lastPos = this.base + this.buffer.length - 1;
        for (const cursor of this.cursors) {
            if (cursor.waiter && cursor.position <= lastPos) {
                const idx = cursor.position - this.base;
                const item = this.buffer[idx];
                cursor.position += 1;
                const w = cursor.waiter;
                cursor.waiter = null;
                w.resolve({ value: item, done: false });
            }
        }
        this.trim();
    }
    /**
     * Close the queue. New readers see immediate end-of-stream. Existing
     * readers can still drain values that were published before close;
     * once their cursor reaches the end of the buffer they see end-of-stream.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        // Wake any currently parked waiters. We do not clear the buffer here
        // so that already-published values remain available to cursors that
        // have not yet drained them.
        for (const cursor of this.cursors) {
            if (cursor.waiter && cursor.position - this.base >= this.buffer.length) {
                const w = cursor.waiter;
                cursor.waiter = null;
                w.resolve({ value: undefined, done: true });
            }
        }
    }
    /** Create a new independent reader. */
    reader() {
        const cursor = {
            position: this.base + this.buffer.length,
            waiter: null,
            detached: this.closed,
        };
        if (!this.closed)
            this.cursors.add(cursor);
        const queue = this;
        const detach = () => {
            if (!cursor.detached) {
                cursor.detached = true;
                queue.cursors.delete(cursor);
                queue.trim();
            }
        };
        const iter = {
            [Symbol.asyncIterator]() {
                return this;
            },
            next() {
                // Once the iterator has been detached via `return()`, all
                // subsequent `next()` calls resolve `done: true` immediately —
                // even if there are unread buffered values. AsyncIterator
                // semantics require `return()` to be terminal.
                if (cursor.detached) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                const idx = cursor.position - queue.base;
                if (idx >= 0 && idx < queue.buffer.length) {
                    const item = queue.buffer[idx];
                    cursor.position += 1;
                    queue.trim();
                    return Promise.resolve({ value: item, done: false });
                }
                if (queue.closed) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise(resolve => {
                    cursor.waiter = { resolve };
                });
            },
            return() {
                detach();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
        return iter;
    }
    [Symbol.asyncIterator]() {
        return this.reader();
    }
    /** Drop buffer entries that every cursor has already consumed. */
    trim() {
        if (this.cursors.size === 0) {
            const dropped = this.buffer.length;
            if (dropped > 0) {
                this.buffer = [];
                this.base += dropped;
            }
            return;
        }
        let minPos = Infinity;
        for (const cursor of this.cursors) {
            if (cursor.position < minPos)
                minPos = cursor.position;
        }
        const drop = minPos - this.base;
        if (drop > 0) {
            this.buffer.splice(0, drop);
            this.base += drop;
        }
    }
}
