precision highp float;
uniform vec2 minmax;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform float u_sweepMode;
uniform float u_sweepStart;
uniform float u_sweepProgress;
uniform float u_gateFilterMin;
uniform float u_gateFilterMax;
varying float color;
varying float v_sinAz;
varying float v_cosAz;

void main() {
    if (color < u_gateFilterMin || color > u_gateFilterMax) discard;

    if (u_sweepMode > 0.5) {
        float PI2 = 6.283185307;
        float az = atan(v_sinAz, v_cosAz);
        if (az < 0.0) az += PI2;
        float offset = mod(az - u_sweepStart + PI2, PI2);
        if (u_sweepMode < 1.5 && offset >= u_sweepProgress) discard;
        if (u_sweepMode > 1.5 && offset < u_sweepProgress) discard;
    }

    float calcolor = (color - minmax.x) / (minmax.y - minmax.x);
    vec4 texColor = texture2D(u_texture, vec2(min(max(calcolor, 0.0), 1.0), 0.0));
    gl_FragColor = vec4(texColor.rgb, texColor.a * u_opacity);
}
