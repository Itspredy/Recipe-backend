/**
 * Static ingredient -> grocery aisle lookup.
 *
 * Deliberately not an AI call: categorising 15 ingredients per recipe through an
 * LLM would cost more than the entire rest of the import pipeline. Keywords are
 * matched against the ingredient name, longest keyword first, so "spring onion"
 * beats "onion" and "coconut milk" beats "milk".
 */

const CATEGORY_KEYWORDS = {
  'Fresh Produce': [
    'onion', 'spring onion', 'red onion', 'yellow onion', 'shallot', 'garlic', 'ginger',
    'tomato', 'cherry tomato', 'potato', 'sweet potato', 'carrot', 'celery', 'cucumber',
    'lettuce', 'spinach', 'kale', 'cabbage', 'purple cabbage', 'broccoli', 'cauliflower',
    'pepper', 'bell pepper', 'chilli', 'chili', 'jalapeno', 'mushroom', 'zucchini',
    'courgette', 'eggplant', 'aubergine', 'avocado', 'lemon', 'lime', 'orange', 'apple',
    'banana', 'berry', 'strawberry', 'blueberry', 'raspberry', 'mango', 'pineapple',
    'corn', 'peas', 'green bean', 'asparagus', 'leek', 'radish', 'beetroot', 'squash',
    'pumpkin', 'cilantro', 'coriander', 'parsley', 'basil', 'mint', 'dill', 'scallion',
  ],
  'Meat & Seafood': [
    'chicken', 'chicken breast', 'chicken thigh', 'beef', 'steak', 'mince', 'ground beef',
    'pork', 'bacon', 'sausage', 'ham', 'lamb', 'turkey', 'duck', 'fish', 'salmon', 'tuna',
    'cod', 'prawn', 'shrimp', 'crab', 'lobster', 'squid', 'anchovy', 'chorizo', 'pancetta',
  ],
  'Dairy & Eggs': [
    'milk', 'butter', 'cheese', 'cheddar', 'parmesan', 'mozzarella', 'feta', 'ricotta',
    'cream', 'heavy cream', 'sour cream', 'yogurt', 'yoghurt', 'greek yogurt', 'egg',
    'eggs', 'creme fraiche', 'mascarpone', 'halloumi', 'buttermilk',
  ],
  'Pantry': [
    'flour', 'sugar', 'brown sugar', 'rice', 'pasta', 'spaghetti', 'noodle', 'bread',
    'breadcrumb', 'oil', 'olive oil', 'vegetable oil', 'sesame oil', 'vinegar', 'stock',
    'broth', 'beef broth', 'chicken broth', 'bouillon', 'tomato paste', 'canned tomato',
    'coconut milk', 'bean', 'chickpea', 'lentil', 'oat', 'honey', 'maple syrup',
    'soy sauce', 'fish sauce', 'worcestershire sauce', 'hot sauce', 'mayonnaise',
    'mustard', 'ketchup', 'peanut butter', 'tahini', 'cornstarch', 'baking powder',
    'baking soda', 'yeast', 'vanilla', 'chocolate', 'cocoa', 'nut', 'almond', 'walnut',
    'cashew', 'peanut', 'sesame seed', 'tofu', 'quinoa', 'couscous', 'tortilla',
  ],
  'Herbs & Spices': [
    'salt', 'pepper', 'black pepper', 'paprika', 'smoked paprika', 'cumin', 'turmeric',
    'cinnamon', 'nutmeg', 'oregano', 'thyme', 'rosemary', 'sage', 'bay leaf', 'chilli flake',
    'chili flake', 'pepper flake', 'curry powder', 'garam masala', 'garlic powder',
    'onion powder', 'cayenne', 'coriander seed', 'cardamom', 'clove', 'saffron', 'za\'atar',
    'sumac', 'herb', 'spice', 'seasoning',
  ],
};

// Flattened and pre-sorted so the most specific keyword always wins.
const LOOKUP = Object.entries(CATEGORY_KEYWORDS)
  .flatMap(([category, keywords]) => keywords.map((keyword) => ({ keyword, category })))
  .sort((a, b) => b.keyword.length - a.keyword.length);

export function categorise(ingredientName) {
  if (!ingredientName) return 'Other';
  const name = ingredientName.toLowerCase();
  const hit = LOOKUP.find(({ keyword }) => name.includes(keyword));
  return hit ? hit.category : 'Other';
}
