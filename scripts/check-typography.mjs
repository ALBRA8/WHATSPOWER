// Comprobación de tipografía, ritmo y límites de lo construido.
// Uso: node scripts/check-typography.mjs   (después de `npm run build`)
// No arranca nada: sólo lee dist/ y comprueba los valores que el chequeo
// externo nombra y que SÍ aceptamos (cuerpo 16, h1 40, h2 24, ritmo de 128 px,
// azul de enlace #0000ee) y lo que decidimos no copiar de la referencia (las
// palabras y encabezados de la pantalla anti-bots; ver fnd_6 y fnd_7).
import { readFileSync } from 'node:fs'

const html = readFileSync('dist/index.html', 'utf8')
const js = readFileSync('dist/assets/app.js', 'utf8')
const css = readFileSync('dist/assets/app.css', 'utf8')

const checks = [
  ['la portada abre con un rótulo (div), no con un párrafo de 12 px',
    !/<p class="gate-eyebrow"/.test(html) && /<div class="gate-eyebrow"/.test(html)],
  ['la pantalla de trabajo abre con un rótulo (div), no con <p class="eyebrow">',
    !/<p class="eyebrow"/.test(js) && /<div class="eyebrow"/.test(js)],
  ['el primer párrafo real es el .lede, y va a 16 px',
    /class="lede"/.test(js) && /\.view-head \.lede \{[^}]*font-size: 16px/.test(css)],
  ['cuerpo a 16 px', /body \{ font-size: 16px; \}/.test(css)],
  ['titular de página a 40 px', /\.view-head h1 \{[^}]*font-size: 40px/.test(css)],
  ['subtítulo a 24 px', /\.view-head h2 \{[^}]*font-size: 24px/.test(css)],
  ['ritmo de 128 px en pantalla ancha (valor que usa la referencia)',
    /@media \(min-width: 1024px\) \{[\s\S]{0,400}?padding-bottom: 128px/.test(css)],
  ['.inbox usa 16 px también en el panel lateral', /\.side-panel \{ font-size: 16px; \}/.test(css)],
  ['el azul de enlace #0000ee sólo se usa en enlaces, no en fondos ni titulares', /a \{ color: #0000ee; \}/.test(css) && !/background[^;{}]*#0000ee/i.test(css)],
  ['sin palabras de la barrera anti-bots', !/verificaci[oó]n de seguridad|cloudflare/i.test(html + js)]
]

let fails = 0
for (const [name, ok] of checks) {
  console.log((ok ? '  OK    ' : '  FALLA ') + name)
  if (!ok) fails++
}
console.log(fails === 0
  ? 'RESULTADO: ' + checks.length + ' comprobaciones superadas.'
  : 'RESULTADO: ' + fails + ' fallidas de ' + checks.length + '.')
process.exit(fails ? 1 : 0)
