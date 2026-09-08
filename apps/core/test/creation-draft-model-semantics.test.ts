import { describe, expect, it } from "vitest";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
} from "../src/builtin-models";
import { generateModelContract } from "../src/model-contract";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { validateDefinition, type PublishedModel } from "../src/model-registry";
import { creationDraftModelDescriptors } from "../src/registry-creation-draft";

const baselineDefinitions = [
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
];
const releaseFingerprint = Object.freeze({
  task: Object.freeze({ version: 6, schemaHash: "e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e" }),
  wish: Object.freeze({ version: 6, schemaHash: "7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df" }),
  day_record: Object.freeze({ version: 3, schemaHash: "9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852" }),
  event: Object.freeze({ version: 4, schemaHash: "35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f" }),
});
// This is the deterministic contract for an isolated Registry containing exactly
// the four baseline models above. A deployed Registry may legitimately have a
// different activeÛ¿uëVòµë(š+myÛˆH™\Ûİ\˜ÙKœ›Ü\Y\ÏË˜][™YT\œÛÛ’YÏË–È[Y™\ÜXÙK\™[][Ûˆ—H\È™XÛÜ™İš[™Ë[šÛ›İÛÂˆ^Xİ
Ù[™\˜]Y™[][ÛŠKÑ\]X[
Âˆ\™Ù][Ù[ˆ][™YKœ™[][ÛË\™Ù][Ù[ˆØ\™[˜[]Nˆ][™YKœ™[][ÛË˜Ø\™[˜[]KˆJNÂˆ^Xİ
Ù[™\˜]Y™[][ÛŠK››İÒ]™T›Ü\J›ÛÚİ\ŠNÂˆ^Xİ
Ù[™\˜]Y™[][ÛŠK››İÒ]™T›Ü\Jœ™\ÛÛ][ÛˆŠNÂˆ^Xİ
][™YKœ™[][ÛËœ™\ÛÛ][ÛŠKÑ\]X[
Âˆİ\ÜYˆYKˆY]Ùˆ”ÔÕ‹ˆ][\]Nˆ‹Ø\KİŒKÜÜXÙ\ËŞÜÜXÙRYK×Ü™Y™\™[˜ÙK\™\ÛÛ][ÛœËŞÛ[Ù[Ù^_KŞÙšY[Ù^_H‹ˆX^YÎˆLˆJNÂˆ›Üˆ
ÛÛœİÚÙ^K˜[YWHÙˆØš™Xİ™[šY\Ê˜XİË™Y˜][ÊJHÂˆYˆ
Ü™X]Kœ›Ü\Y\ÏË–ÚÙ^WJH^Xİ
Ü™X]Kœ›Ü\Y\ÖÚÙ^WK™Y˜][
KÑ\]X[
˜[YJNÂˆBˆJNÂ‚ˆ]
›X]Ú\È™\™\Ù[]]™Hİ\œ™[[[YH\ØÛİ™\Hİ]]Ú]İ]İ\œ™[]]Üš]HXZÚ[™È[Èİ]XÈ˜XİÈ‹\Ş[˜È

HOˆÂˆÛÛœİ^[ØYH]ØZ][[YQ\ØÛİ™\Qš^\™J
NÂˆÛÛœİ\ÚÔ[[YHH^[ØY™]K›[Ù[Ë™š[™

[JHOˆ[KšÙ^HOOH\ÚÈŠHNÂˆÛÛœİ]™[[[YHH^[ØY™]K›[Ù[Ë™š[™

[JHOˆ[KšÙ^HOOH™]™[ŠHNÂˆÛÛœİ\ÚÑ˜XİÈH›Ú™Xİ[Ù[Ù[X[XÑ˜XİÊX›\ÚY
TÒ×ÓSÑSÑQ’S’USÓŠJNÂˆÛÛœİ]™[˜XİÈH›Ú™Xİ[Ù[Ù[X[XÑ˜XİÊX›\ÚY
U‘S•ÓSÑSÑQ’S’USÓŠJNÂ‚ˆ^Xİ
\ÚÔ[[YK™Y˜][ÊKÑ\]X[
\ÚÑ˜XİË™Y˜][ÊNÂˆ^Xİ

\ÚÔ[[YK™šY[È\È\œ˜^O™XÛÜ™İš[™Ë[šÛ›İÛŠK›X\

ÈÙ^K\K]K\ØÜš\[Û‹™\]Z\™Y[X›K[[]]X›K™XYÛ›HJHOˆ
ÂˆÙ^K\K]K\ØÜš\[Û‹™\]Z\™Y[X›K[[]]X›K™XYÛ›KˆJJJKÑ\]X[
\ÚÑ˜XİË™šY[Ë›X\

ÈÙ^K\K]K\ØÜš\[Û‹™\]Z\™Y[X›K[[]]X›K™XYÛ›HJHOˆ
ÂˆÙ^K\K]K\ØÜš\[Û‹™\]Z\™Y[X›K[[]]X›K™XYÛ›KˆJJJNÂ‚ˆÛÛœİ[[YT]Y\HH\ÚÔ[[YKœ]Y\H\ÈÂˆÙX\˜ÚX›Nˆİš[™Ö×NÈš[\˜X›Nˆİš[™Ö×NÈÛÜX›Nˆİš[™Ö×NÂˆÛÜˆ™XÛÜ™İš[™Ë[šÛ›İÛÂˆNÂˆ^Xİ
[[YT]Y\KœÙX\˜ÚX›JKÑ\]X[
\ÚÑ˜XİËœ]Y\KœÙX\˜ÚX›JNÂˆ^Xİ
[[YT]Y\K™š[\˜X›JKÑ\]X[
\ÚÑ˜XİËœ]Y\K™š[\˜X›JNÂˆ^Xİ
[[YT]Y\KœÛÜX›JKÑ\]X[
\ÚÑ˜XİËœ]Y\KœÛÜX›JNÂˆ^Xİ
[[YT]Y\KœÛÜ
KÑ\]X[
Âˆ\˜[Y]\ˆ\ÚÑ˜XİËœ]Y\KœÛÜœ\˜[Y]\‹ˆŞ[^ˆ\ÚÑ˜XİËœ]Y\KœÛÜœŞ[^ˆ™\X]X›Nˆ\ÚÑ˜XİËœ]Y\KœÛÜœ™\X]X›KˆÜ™\™Yˆ\ÚÑ˜XİËœ]Y\KœÛÜ›Ü™\™YˆX^Üš]\šXNˆ\ÚÑ˜XİËœ]Y\KœÛÜ›X^Üš]\šXKˆY˜][ˆ\ÚÑ˜XİËœ]Y\KœÛÜ™Ù[™\šXÑY˜][ˆ[™[ÜQšY[Îˆ\ÚÑ˜XİËœ]Y\KœÛÜ™[™[ÜQšY[ËˆJNÂ‚ˆÛÛœİ[[YPXİ[ÛœÈH\ÚÔ[[YK˜Xİ[ÛœÈ\È\œ˜^O™XÛÜ™İš[™Ë[šÛ›İÛÂˆ›Üˆ
ÛÛœİXİ[ÛˆÙˆ[[YPXİ[ÛœÊHÂˆÛÛœİÚ\™YH\ÚÑ˜XİË˜Xİ[ÛœË™š[™

[JHOˆ[KšÙ^HOOHXİ[Û‹šÙ^JHNÂˆ^Xİ
Xİ[ÛŠKÑ\]X[
ÂˆÙ^NˆÚ\™YšÙ^KˆXØÙ\ÜÎˆÚ\™Y˜XØÙ\ÜËˆÚ[™ˆÚ\™YšÚ[™ˆ[œ]ˆÚ\™Yš[œ]ˆÛÛ˜İ\œ™[˜ŞNˆÚ\™Y˜ÛÛ˜İ\œ™[˜ŞKˆJNÂˆB‚ˆ^Xİ
]™[[[YK˜Ø\Xš[]Y\ÊKÑ\]X[
]™[˜XİË˜Ø\Xš[]Y\ÊNÂˆÛÛœİ[[YPš[™[™ÜÈH]™[[[YK˜Ø\Xš[]Pš[™[™ÜÈ\ÈÈØ[[™\Îˆ[šÛ›İÛˆNÂˆ^Xİ
[[YPš[™[™ÜË˜Ø[[™\ŠKÑ\]X[
]™[˜XİË˜Ø\Xš[]Pš[™[™ÜË˜Ø[[™\ŠNÂˆ^Xİ
\ÚÔ[[YK˜XØÙ\ÜÊKÑ\]X[
Èœ™XY‹Üš]H—JNÂˆ^Xİ
\ÚÑ˜XİË™XÛ\™YXØÙ\ÜÊKÑ\]X[
TÒ×ÓSÑSÑQ’S’USÓ‹˜XØÙ\ÜÊNÂˆ^Xİ
\ÚÑ˜XİÊK››İÒ]™T›Ü\JœÜXÙRYŠNÂˆ^Xİ
\ÚÑ˜XİÊK››İÒ]™T›Ü\J™[YØ][Û’YŠNÂˆJNÂŸJNÂ‚