package app.mysignet

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver

/**
 * Runs [action] once [lifecycle] is resumed: now if it already is, else on
 * its next ON_RESUME. Calls [gone] instead if it is destroyed first.
 * Exactly one of the two runs, once. Call it on the main thread.
 *
 * For anything that has to be shown by an activity in front, such as a
 * BiometricPrompt, which a stopped activity drops without a word.
 */
fun whenResumed(lifecycle: Lifecycle, action: () -> Unit, gone: () -> Unit) {
    when {
        lifecycle.currentState == Lifecycle.State.DESTROYED -> gone()
        lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) -> action()
        else -> lifecycle.addObserver(object : LifecycleEventObserver {
            override fun onStateChanged(source: androidx.lifecycle.LifecycleOwner, event: Lifecycle.Event) {
                when (event) {
                    Lifecycle.Event.ON_RESUME -> { lifecycle.removeObserver(this); action() }
                    Lifecycle.Event.ON_DESTROY -> { lifecycle.removeObserver(this); gone() }
                    else -> {}
                }
            }
        })
    }
}
