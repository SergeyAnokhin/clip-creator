import asyncio

from app import storage


def test_project_lock_serializes_concurrent_critical_sections():
    """Regression test for the concurrent-save race (see storage.project_lock's
    docstring and docs/architecture.md's 'Concurrent-save race' gotcha): a
    second `async with project_lock(slug):` block must not start its
    load-mutate-save sequence until the first one - even a slower one -
    has fully finished, so a later save can never be built from a snapshot
    that predates an earlier one's write."""
    async def scenario():
        order = []

        async def worker(name, delay):
            async with storage.project_lock('proj-x'):
                order.append(f'{name}-start')
                await asyncio.sleep(delay)
                order.append(f'{name}-end')

        await asyncio.gather(worker('A', 0.05), worker('B', 0))
        return order

    order = asyncio.run(scenario())
    assert order == ['A-start', 'A-end', 'B-start', 'B-end']


def test_project_lock_different_slugs_do_not_block_each_other():
    async def scenario():
        order = []

        async def worker(name, slug, delay):
            async with storage.project_lock(slug):
                order.append(f'{name}-start')
                await asyncio.sleep(delay)
                order.append(f'{name}-end')

        await asyncio.gather(worker('A', 'proj-a', 0.05), worker('B', 'proj-b', 0))
        return order

    order = asyncio.run(scenario())
    assert order.index('B-end') < order.index('A-end')
