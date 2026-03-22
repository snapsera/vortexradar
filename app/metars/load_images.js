const use_data = require('./use_data');
const create_square_with_text = require('../core/misc/create_square_with_text');
const get_temp_color = require('../core/misc/temp_colors');

function _add_image_to_map(image_url, image_name, callback) {
    const img = new Image(200, 200);
    img.onload = () => map.addImage(image_name, img);
    img.src = image_url;
}

function load_images(parsedXMLData) {
    var all_images_to_add = [];

    for (var i = 0; i < 120; i++) {
        const temp_color = get_temp_color(i);
        const png_data = create_square_with_text(`${i}`, temp_color[0], temp_color[1], 200, 1.2);
        all_images_to_add.push([png_data, `${i}`]);
    }

    for (let i = 0; i < all_images_to_add.length; i++) {
        _add_image_to_map(all_images_to_add[i][0], all_images_to_add[i][1]);
    }

    use_data.useData(parsedXMLData);
}

module.exports = load_images;
