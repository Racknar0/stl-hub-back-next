/**
 * STL HUB — Calendario de Eventos para SEO Programático
 * 
 * Cada evento tiene:
 *   mes       : 1-12
 *   dia       : día del mes (opcional, si no hay día fijo)
 *   semanaAntes: cuántas semanas antes publicar (default: 3)
 *   slug      : URL de la colección
 *   titulo    : H1 de la landing
 *   tipo      : 'estacional' | 'evergreen' | 'trending'
 *   tags      : tags de tu BD para buscar modelos relacionados
 *   keywords  : keywords SEO a atacar
 *   minModelos: mínimo de modelos para publicar (default: 8)
 */

export const calendarioEventos = [

  // ══════════════════════════════════════════════
  //  ENERO
  // ══════════════════════════════════════════════
  {
    mes: 1, dia: 1, semanaAntes: 1,
    slug: 'stl-ano-nuevo-impresion-3d',
    titulo: 'Los mejores STL para imprimir en Año Nuevo',
    tipo: 'estacional',
    tags: ['celebracion', 'fiesta', 'decoracion', 'copa', 'brindis', 'confeti'],
    keywords: ['stl año nuevo', 'modelos 3d año nuevo', 'impresion 3d enero'],
  },
  {
    mes: 1, dia: 6, semanaAntes: 1,
    slug: 'stl-reyes-magos',
    titulo: 'Modelos STL de Reyes Magos para imprimir',
    tipo: 'estacional',
    tags: ['reyes', 'magos', 'navidad', 'regalo', 'corona'],
    keywords: ['stl reyes magos', 'modelos reyes magos 3d', 'figuras reyes magos stl'],
  },
  {
    mes: 1, semanaAntes: 0,
    slug: 'stl-faciles-principiantes',
    titulo: 'Modelos STL fáciles para principiantes en impresión 3D',
    tipo: 'evergreen',
    tags: ['facil', 'principiante', 'basico', 'simple', 'low-poly'],
    keywords: ['stl faciles', 'modelos 3d principiantes', 'stl simples para imprimir'],
  },

  // ══════════════════════════════════════════════
  //  FEBRERO
  // ══════════════════════════════════════════════
  {
    mes: 2, dia: 14, semanaAntes: 3,
    slug: 'stl-san-valentin-regalos-3d',
    titulo: 'Regalos STL para San Valentín: Modelos 3D para imprimir',
    tipo: 'estacional',
    tags: ['amor', 'corazon', 'san-valentin', 'romantico', 'pareja', 'rosa', 'anillo'],
    keywords: ['stl san valentin', 'regalo 3d san valentin', 'modelos amor impresion 3d'],
  },
  {
    mes: 2, semanaAntes: 0,
    slug: 'stl-busts-personajes',
    titulo: 'Mejores STL de bustos de personajes para imprimir',
    tipo: 'evergreen',
    tags: ['busto', 'personaje', 'retrato', 'cabeza', 'figura'],
    keywords: ['stl bustos personajes', 'busto 3d imprimir', 'stl busto gratis'],
  },

  // ══════════════════════════════════════════════
  //  MARZO
  // ══════════════════════════════════════════════
  {
    mes: 3, dia: 8, semanaAntes: 2,
    slug: 'stl-dia-mujer-figuras-femeninas',
    titulo: 'Modelos STL de figuras femeninas — Día de la Mujer',
    tipo: 'estacional',
    tags: ['mujer', 'femenino', 'figura-femenina', 'empoderada', 'warrior'],
    keywords: ['stl figuras femeninas', 'modelos 3d dia mujer', 'stl personajes mujeres'],
  },
  {
    mes: 3, semanaAntes: 0,
    slug: 'stl-resina-alta-calidad',
    titulo: 'Los mejores STL para impresora de resina (alta calidad)',
    tipo: 'evergreen',
    tags: ['resina', 'detalle', 'miniatura', 'figura', 'alto-detalle'],
    keywords: ['stl para resina', 'stl resina alta calidad', 'modelos impresora resina'],
  },
  {
    mes: 3, semanaAntes: 0,
    slug: 'mejores-stl-anime',
    titulo: 'Los mejores archivos STL de Anime para imprimir',
    tipo: 'evergreen',
    tags: ['anime', 'manga', 'japon', 'figura-anime'],
    keywords: ['stl anime', 'figuras anime stl', 'descargar stl anime gratis'],
  },

  // ══════════════════════════════════════════════
  //  ABRIL
  // ══════════════════════════════════════════════
  {
    mes: 4, semanaAntes: 0,
    slug: 'stl-decoracion-jardin-primavera',
    titulo: 'STL para decoración de jardín y primavera',
    tipo: 'estacional',
    tags: ['jardin', 'maceta', 'flor', 'planta', 'decoracion', 'primavera', 'exterior'],
    keywords: ['stl jardin', 'modelos 3d decoracion jardin', 'stl macetas gratis'],
  },
  {
    mes: 4, dia: 20, semanaAntes: 2,
    slug: 'stl-semana-santa-pascua',
    titulo: 'Modelos STL religiosos y de Pascua para imprimir',
    tipo: 'estacional',
    tags: ['semana-santa', 'pascua', 'religioso', 'jesus', 'iglesia', 'conejo'],
    keywords: ['stl semana santa', 'stl pascua', 'modelos religiosos 3d'],
  },
  {
    mes: 4, semanaAntes: 0,
    slug: 'stl-dragon-ball',
    titulo: 'Los mejores STL de Dragon Ball para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['dragon-ball', 'goku', 'vegeta', 'dbz', 'anime'],
    keywords: ['stl dragon ball', 'stl goku', 'figuras dragon ball 3d gratis'],
  },

  // ══════════════════════════════════════════════
  //  MAYO
  // ══════════════════════════════════════════════
  {
    mes: 5, dia: 11, semanaAntes: 3,
    slug: 'stl-dia-madre-regalos-imprimir',
    titulo: 'Regalos STL para el Día de la Madre: Ideas para imprimir',
    tipo: 'estacional',
    tags: ['madre', 'mama', 'regalo', 'flor', 'corazon', 'decoracion', 'joyero'],
    keywords: ['stl dia madre', 'regalo 3d dia de la madre', 'stl para imprimir mama'],
  },
  {
    mes: 5, dia: 4, semanaAntes: 1,
    slug: 'stl-star-wars-dia-fuerza',
    titulo: 'Los mejores STL de Star Wars — May the 4th be with you',
    tipo: 'estacional',
    tags: ['star-wars', 'jedi', 'sith', 'lightsaber', 'mandalorian', 'darth-vader'],
    keywords: ['stl star wars', 'may the 4th stl', 'modelos star wars impresion 3d'],
  },
  {
    mes: 5, semanaAntes: 0,
    slug: 'stl-marvel-superheroes',
    titulo: 'Los mejores STL de Marvel para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['marvel', 'superheroe', 'iron-man', 'spiderman', 'capitan-america', 'thor'],
    keywords: ['stl marvel', 'figuras marvel 3d', 'stl superheroes marvel gratis'],
  },
  {
    mes: 5, semanaAntes: 0,
    slug: 'stl-one-piece',
    titulo: 'Los mejores STL de One Piece para impresión 3D',
    tipo: 'evergreen',
    tags: ['one-piece', 'luffy', 'zoro', 'nami', 'anime'],
    keywords: ['stl one piece', 'figuras one piece 3d', 'stl luffy gratis'],
  },

  // ══════════════════════════════════════════════
  //  JUNIO
  // ══════════════════════════════════════════════
  {
    mes: 6, dia: 15, semanaAntes: 3,
    slug: 'stl-dia-padre-regalos',
    titulo: 'Regalos STL para el Día del Padre — Ideas para imprimir',
    tipo: 'estacional',
    tags: ['padre', 'papa', 'herramienta', 'regalo', 'hombre', 'organizador', 'llavero'],
    keywords: ['stl dia del padre', 'regalo 3d dia del padre', 'stl para papa imprimir'],
  },
  {
    mes: 6, semanaAntes: 0,
    slug: 'stl-dc-comics-batman-superman',
    titulo: 'Los mejores STL de DC Comics para imprimir',
    tipo: 'evergreen',
    tags: ['dc', 'batman', 'superman', 'wonder-woman', 'joker', 'flash'],
    keywords: ['stl dc comics', 'stl batman', 'figuras dc impresion 3d gratis'],
  },
  {
    mes: 6, semanaAntes: 0,
    slug: 'stl-miniaturas-wargaming',
    titulo: 'STL de miniaturas para Wargaming y juegos de mesa',
    tipo: 'evergreen',
    tags: ['miniatura', 'wargaming', 'juego-mesa', 'dnd', 'dungeon', 'ejercito'],
    keywords: ['stl miniaturas wargaming', 'stl dnd gratis', 'miniaturas 3d juegos mesa'],
  },

  // ══════════════════════════════════════════════
  //  JULIO
  // ══════════════════════════════════════════════
  {
    mes: 7, semanaAntes: 0,
    slug: 'stl-cosplay-cascos-completos',
    titulo: 'Los mejores STL de cascos para cosplay',
    tipo: 'evergreen',
    tags: ['casco', 'cosplay', 'helmet', 'mascara', 'armor'],
    keywords: ['stl cascos cosplay', 'casco cosplay stl gratis', 'stl helmet impresion 3d'],
  },
  {
    mes: 7, semanaAntes: 0,
    slug: 'stl-videojuegos-clasicos',
    titulo: 'STL de videojuegos clásicos para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['videojuego', 'gaming', 'retro', 'consola', 'controller'],
    keywords: ['stl videojuegos', 'figuras videojuegos 3d', 'stl gaming gratis'],
  },
  {
    mes: 7, semanaAntes: 0,
    slug: 'stl-decoracion-hogar-moderno',
    titulo: 'STL de decoración moderna para el hogar',
    tipo: 'evergreen',
    tags: ['decoracion', 'hogar', 'moderno', 'minimalista', 'lampara', 'vaso'],
    keywords: ['stl decoracion hogar', 'modelos 3d decoracion', 'stl casa impresion 3d'],
  },

  // ══════════════════════════════════════════════
  //  AGOSTO
  // ══════════════════════════════════════════════
  {
    mes: 8, semanaAntes: 0,
    slug: 'stl-naruto-personajes',
    titulo: 'Los mejores STL de Naruto para imprimir',
    tipo: 'evergreen',
    tags: ['naruto', 'sasuke', 'kakashi', 'anime', 'ninja'],
    keywords: ['stl naruto', 'figuras naruto 3d', 'stl naruto gratis descargar'],
  },
  {
    mes: 8, semanaAntes: 0,
    slug: 'stl-herramientas-utiles-hogar',
    titulo: 'STL de herramientas y accesorios útiles para imprimir',
    tipo: 'evergreen',
    tags: ['herramienta', 'util', 'organizar', 'soporte', 'clip', 'funcional'],
    keywords: ['stl herramientas utiles', 'stl funcionales gratis', 'accesorios 3d hogar'],
  },
  {
    mes: 8, semanaAntes: 0,
    slug: 'stl-pokemon-figuras',
    titulo: 'Los mejores STL de Pokémon para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['pokemon', 'pikachu', 'eevee', 'charizard', 'anime'],
    keywords: ['stl pokemon', 'figuras pokemon 3d', 'stl pikachu gratis'],
  },

  // ══════════════════════════════════════════════
  //  SEPTIEMBRE
  // ══════════════════════════════════════════════
  {
    mes: 9, semanaAntes: 0,
    slug: 'stl-jujutsu-kaisen',
    titulo: 'Los mejores STL de Jujutsu Kaisen para impresión 3D',
    tipo: 'evergreen',
    tags: ['jujutsu-kaisen', 'gojo', 'itadori', 'sukuna', 'anime'],
    keywords: ['stl jujutsu kaisen', 'figuras jujutsu kaisen 3d', 'stl gojo gratis'],
  },
  {
    mes: 9, semanaAntes: 0,
    slug: 'stl-fnaf-terror',
    titulo: 'STL de FNAF y personajes de terror para imprimir',
    tipo: 'evergreen',
    tags: ['fnaf', 'terror', 'horror', 'cinco-noches', 'animatronic'],
    keywords: ['stl fnaf', 'stl five nights freddy', 'modelos terror 3d gratis'],
  },
  {
    mes: 9, semanaAntes: 2,
    slug: 'stl-halloween-preparacion',
    titulo: 'Prepárate para Halloween: Los mejores STL de terror',
    tipo: 'estacional',
    tags: ['halloween', 'terror', 'calavera', 'calabaza', 'bruja', 'fantasma', 'zombie'],
    keywords: ['stl halloween', 'decoracion halloween impresion 3d', 'stl terror gratis'],
  },

  // ══════════════════════════════════════════════
  //  OCTUBRE
  // ══════════════════════════════════════════════
  {
    mes: 10, dia: 31, semanaAntes: 4,
    slug: 'stl-halloween-decoracion-completa',
    titulo: 'Decoración de Halloween con impresión 3D — Los mejores STL',
    tipo: 'estacional',
    tags: ['halloween', 'terror', 'calavera', 'calabaza', 'bruja', 'fantasma', 'muerto', 'cementerio'],
    keywords: ['stl halloween decoracion', 'impresion 3d halloween', 'stl calabaza terror gratis'],
  },
  {
    mes: 10, semanaAntes: 0,
    slug: 'stl-resident-evil-personajes',
    titulo: 'Los mejores STL de Resident Evil para imprimir',
    tipo: 'evergreen',
    tags: ['resident-evil', 'zombie', 'leon', 'nemesis', 'horror'],
    keywords: ['stl resident evil', 'figuras resident evil 3d', 'stl nemesis gratis'],
  },
  {
    mes: 10, semanaAntes: 0,
    slug: 'stl-calaveras-day-of-dead',
    titulo: 'STL de calaveras y Día de Muertos para imprimir',
    tipo: 'estacional',
    tags: ['calavera', 'dia-muertos', 'mexico', 'catrina', 'sugar-skull'],
    keywords: ['stl dia de muertos', 'stl calaveras', 'catrina stl gratis imprimir'],
  },

  // ══════════════════════════════════════════════
  //  NOVIEMBRE
  // ══════════════════════════════════════════════
  {
    mes: 11, dia: 11, semanaAntes: 3,
    slug: 'stl-regalos-black-friday',
    titulo: 'Ideas de regalos STL para imprimir esta temporada',
    tipo: 'estacional',
    tags: ['regalo', 'llavero', 'decoracion', 'personalizado', 'joyero', 'organizador'],
    keywords: ['stl regalos imprimir', 'ideas regalo impresion 3d', 'stl personalizados regalo'],
  },
  {
    mes: 11, semanaAntes: 0,
    slug: 'stl-demon-slayer-kimetsu',
    titulo: 'Los mejores STL de Demon Slayer (Kimetsu no Yaiba)',
    tipo: 'evergreen',
    tags: ['demon-slayer', 'kimetsu', 'tanjiro', 'nezuko', 'anime'],
    keywords: ['stl demon slayer', 'figuras kimetsu no yaiba 3d', 'stl tanjiro gratis'],
  },
  {
    mes: 11, semanaAntes: 0,
    slug: 'stl-stranger-things',
    titulo: 'Mejores STL de Stranger Things para impresión 3D',
    tipo: 'evergreen',
    tags: ['stranger-things', 'demogorgon', 'eleven', 'netflix', 'serie'],
    keywords: ['stl stranger things', 'figuras stranger things 3d', 'stl demogorgon gratis'],
  },

  // ══════════════════════════════════════════════
  //  DICIEMBRE
  // ══════════════════════════════════════════════
  {
    mes: 12, dia: 25, semanaAntes: 5,
    slug: 'stl-navidad-decoracion-arbol',
    titulo: 'Decoración de Navidad con impresión 3D — Los mejores STL',
    tipo: 'estacional',
    tags: ['navidad', 'arbol', 'regalo', 'santa', 'reno', 'copo-nieve', 'angel', 'estrella'],
    keywords: ['stl navidad', 'decoracion navidad impresion 3d', 'adornos navidad stl gratis'],
  },
  {
    mes: 12, semanaAntes: 3,
    slug: 'stl-regalo-navidad-imprimir',
    titulo: 'Regalos de Navidad que puedes imprimir en 3D',
    tipo: 'estacional',
    tags: ['regalo', 'navidad', 'personalizado', 'llavero', 'figura', 'joyero'],
    keywords: ['regalo navidad impresion 3d', 'stl regalo navidad', 'que imprimir en navidad'],
  },
  {
    mes: 12, semanaAntes: 0,
    slug: 'stl-attack-on-titan',
    titulo: 'Los mejores STL de Attack on Titan para imprimir',
    tipo: 'evergreen',
    tags: ['attack-on-titan', 'eren', 'levi', 'titan', 'anime'],
    keywords: ['stl attack on titan', 'figuras shingeki no kyojin 3d', 'stl eren gratis'],
  },

  // ══════════════════════════════════════════════
  //  EVERGREEN — Sin mes fijo (rotar todo el año)
  // ══════════════════════════════════════════════
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-iron-man-armaduras',
    titulo: 'Los mejores STL de Iron Man y armaduras para imprimir',
    tipo: 'evergreen',
    tags: ['iron-man', 'armadura', 'marvel', 'tony-stark', 'casco'],
    keywords: ['stl iron man', 'armadura iron man stl', 'casco iron man impresion 3d'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-lord-of-the-rings',
    titulo: 'Los mejores STL de El Señor de los Anillos',
    tipo: 'evergreen',
    tags: ['lord-of-the-rings', 'tolkien', 'gandalf', 'aragorn', 'fantasy'],
    keywords: ['stl senor de los anillos', 'stl lotr', 'figuras tolkien 3d gratis'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-game-of-thrones',
    titulo: 'Modelos STL de Game of Thrones para imprimir',
    tipo: 'evergreen',
    tags: ['game-of-thrones', 'dragon', 'stark', 'lannister', 'daenerys'],
    keywords: ['stl game of thrones', 'figuras got 3d', 'stl daenerys dragon gratis'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-funko-pop-estilo',
    titulo: 'STL estilo Funko Pop para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['funko', 'pop', 'chibi', 'cartoon', 'figura-coleccion'],
    keywords: ['stl estilo funko pop', 'funko pop 3d gratis', 'stl chibi personajes'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-zelda-link-nintendo',
    titulo: 'Los mejores STL de Zelda y Link para impresión 3D',
    tipo: 'evergreen',
    tags: ['zelda', 'link', 'nintendo', 'hyrule', 'videojuego'],
    keywords: ['stl zelda', 'stl link 3d', 'figuras zelda gratis imprimir'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-harry-potter',
    titulo: 'Los mejores STL de Harry Potter para imprimir',
    tipo: 'evergreen',
    tags: ['harry-potter', 'hogwarts', 'hermione', 'voldemort', 'varita'],
    keywords: ['stl harry potter', 'figuras harry potter 3d', 'stl hogwarts gratis'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-my-hero-academia',
    titulo: 'Los mejores STL de My Hero Academia para imprimir',
    tipo: 'evergreen',
    tags: ['my-hero-academia', 'deku', 'bakugo', 'todoroki', 'anime'],
    keywords: ['stl my hero academia', 'figuras boku no hero 3d', 'stl deku gratis'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-warhammer-40k',
    titulo: 'STL de Warhammer 40K para imprimir — Miniaturas gratis',
    tipo: 'evergreen',
    tags: ['warhammer', '40k', 'space-marine', 'miniatura', 'ejercito'],
    keywords: ['stl warhammer 40k', 'miniaturas warhammer gratis', 'stl space marine'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-cyberpunk-futurista',
    titulo: 'STL Cyberpunk y Sci-Fi para impresión 3D',
    tipo: 'evergreen',
    tags: ['cyberpunk', 'sci-fi', 'futurista', 'cyborg', 'robot'],
    keywords: ['stl cyberpunk', 'modelos sci-fi 3d', 'stl futurista gratis imprimir'],
  },
  {
    mes: null, semanaAntes: 0,
    slug: 'stl-mitologia-griega',
    titulo: 'STL de Mitología Griega para imprimir en 3D',
    tipo: 'evergreen',
    tags: ['mitologia', 'griega', 'zeus', 'atenea', 'poseidon', 'medusa'],
    keywords: ['stl mitologia griega', 'figuras griegas 3d', 'stl zeus gratis'],
  },
];

// ══════════════════════════════════════════════════
//  HELPER: obtener eventos a publicar esta semana
// ══════════════════════════════════════════════════

/**
 * Devuelve los eventos que deben publicarse en los próximos `ventanaDias` días
 * basado en la fecha actual y el campo `semanaAntes` de cada evento.
 */
export function getEventosParaPublicar(ventanaDias = 7) {
  const hoy = new Date();
  const anio = hoy.getFullYear();

  return calendarioEventos.filter((evento) => {
    if (!evento.mes) return false; // Evergreen sin mes → se programa manualmente

    const diaEvento = evento.dia || 15; // Si no tiene día, asume el 15
    const fechaEvento = new Date(anio, evento.mes - 1, diaEvento);
    const diasAntes = (evento.semanaAntes || 3) * 7;
    const fechaPublicar = new Date(fechaEvento);
    fechaPublicar.setDate(fechaPublicar.getDate() - diasAntes);

    const diffMs = fechaPublicar - hoy;
    const diffDias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return diffDias >= 0 && diffDias <= ventanaDias;
  });
}

/**
 * Devuelve los evergreen (sin mes) ordenados aleatoriamente
 * Para publicar 1 por día cuando no hay estacionales
 */
export function getEvergreenAleatorio(excluirSlug = []) {
  const evergreens = calendarioEventos.filter(
    (e) => e.tipo === 'evergreen' && !excluirSlug.includes(e.slug)
  );
  return evergreens[Math.floor(Math.random() * evergreens.length)] || null;
}
