package app.mysignet

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.assertEquals
import org.junit.Test

class WhenResumedTest {
    private class Owner : LifecycleOwner {
        val registry: LifecycleRegistry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
    }

    private val calls = mutableListOf<String>()
    private fun ask(owner: Owner) = whenResumed(owner.lifecycle, { calls += "action" }) { calls += "gone" }

    @Test fun `a resumed activity is asked at once`() {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        ask(owner)
        assertEquals(listOf("action"), calls)
    }

    @Test fun `a stopped activity waits until it is back in front, then asks once`() {
        // The NIP-55 case: the page asks for the unlock while the activity is
        // still behind the calling app.
        val owner = Owner().apply { registry.currentState = Lifecycle.State.CREATED }
        ask(owner)
        assertEquals(emptyList<String>(), calls)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertEquals(emptyList<String>(), calls)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        assertEquals(listOf("action"), calls)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        assertEquals(listOf("action"), calls)
    }

    @Test fun `an activity destroyed before it resumes is reported, not left waiting`() {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.CREATED }
        ask(owner)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        assertEquals(listOf("gone"), calls)
    }

    @Test fun `an activity already destroyed is reported at once`() {
        val owner = Owner().apply {
            registry.currentState = Lifecycle.State.CREATED
            registry.currentState = Lifecycle.State.DESTROYED
        }
        ask(owner)
        assertEquals(listOf("gone"), calls)
    }
}
