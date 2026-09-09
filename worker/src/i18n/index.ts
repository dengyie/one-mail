import { LocaleMessages } from "./type.ts";
import zh from "./zh.ts";
import en from "./en.ts";
import { Context } from "hono";

export default {
    getMessages: (
        locale: string | null | undefined
    ): LocaleMessages => {
        // multi-language support
        if (locale === "en") return en;
        if (locale === "zh") return zh;

        // fallback language
        return en;
    },
    getMessagesbyContext: (
        c: Context<HonoCustomType>
    ): LocaleMessages => {
        const locale = c?.get?.("lang") || c.env?.DEFAULT_LANG;
        // multi-language support
        if (locale === "en") return en;
        if (locale === "zh") return zh;

        // fallback language
        return en;
    }
}
