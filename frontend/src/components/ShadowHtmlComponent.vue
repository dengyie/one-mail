<template>
    <div v-if="useFallback" v-html="fallbackHtml"></div>
    <div v-else ref="shadowHost"></div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
    htmlContent: {
        type: String,
        required: true,
    },
    isDark: {
        type: Boolean,
        default: false,
    },
});

const shadowHost = ref(null);
let shadowRoot = null;
const useFallback = ref(false);
const fallbackHtml = ref('');

/**
 * A <style> block in the light DOM restyles the whole page. The fallback has
 * no shadow boundary to contain it, so drop the mail stylesheet rather than
 * leak it; inline styles still carry most of the layout.
 */
const stripStyleTags = (html) => {
    if (typeof document === 'undefined') return html;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    holder.querySelectorAll('style').forEach((node) => node.remove());
    return holder.innerHTML;
};

const enableFallback = () => {
    useFallback.value = true;
    fallbackHtml.value = stripStyleTags(props.htmlContent);
};

/**
 * Renders content into Shadow DOM with fallback to v-html
 */
const renderShadowDom = () => {
    if (!shadowHost.value && !useFallback.value) return;

    try {
        // Don't attempt to use Shadow DOM if already in fallback mode
        if (useFallback.value) return;

        // Initialize Shadow DOM if not already created
        if (!shadowRoot && shadowHost.value) {
            try {
                shadowRoot = shadowHost.value.attachShadow({ mode: 'open' });
            } catch (error) {
                console.warn('Shadow DOM not supported, falling back to v-html:', error);
                enableFallback();
                return;
            }
        }

        // Update content if Shadow DOM exists
        if (shadowRoot) {
            // A light-DOM `img` rule cannot reach into the shadow tree, so
            // keep the same constraint here. The mail's own <style> blocks
            // follow and may override it.
            const baseStyle = `<style>
                img { max-width: 100%; height: auto; }
            </style>`;
            const darkModeStyle = props.isDark
                ? `<style>
                    :host { color: #e0e0e0; }
                    a { color: #A8C7FA; }
                   </style>`
                : '';
            shadowRoot.innerHTML = baseStyle + darkModeStyle + props.htmlContent;
        }
    } catch (error) {
        console.error('Failed to render Shadow DOM, falling back to v-html:', error);
        enableFallback();
    }
};

// Initial render when component is mounted
onMounted(() => {
    // Check if Shadow DOM is supported in this browser
    if (typeof Element.prototype.attachShadow !== 'function') {
        console.warn('Shadow DOM is not supported in this browser, using v-html fallback');
        enableFallback();
        return;
    }

    renderShadowDom();
});

// Clean up resources when component is unmounted
onBeforeUnmount(() => {
    if (shadowRoot) {
        shadowRoot.innerHTML = '';
    }
    shadowRoot = null;
});

// Update Shadow DOM when htmlContent or dark mode changes
watch(() => [props.htmlContent, props.isDark], () => {
    if (useFallback.value) {
        fallbackHtml.value = stripStyleTags(props.htmlContent);
        return;
    }
    renderShadowDom();
}, { flush: 'post' });
</script>
