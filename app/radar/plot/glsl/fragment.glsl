precision highp float;
uniform vec2 minmax;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform float u_sweepMode;
uniform float u_sweepStart;
uniform float u_sweepProgress;
uniform float u_gateFilterMin;
uniform float u_gateFilterMax;
uniform float u_sweepGlowEnabled;
uniform float u_sweepGlowAngle;
uniform float u_sweepGlowTrail;
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
    vec3 outRgb = texColor.rgb;
    float outAlpha = texColor.a * u_opacity;

    // Continuous white glow under the sweep with a smooth trailing fade.
    if (u_sweepGlowEnabled > 0.5) {
        float PI2 = 6.283185307;
        float az = atan(v_sinAz, v_cosAz);
        if (az < 0.0) az += PI2;
        // Offset measured from sweep head backward along the trail direction.
        float offset = mod(u_sweepGlowAngle - az + PI2, PI2);

        // Smoothstep-based trail gives a softer, sweep-like transition.
        float trailNorm = clamp(offset / max(u_sweepGlowTrail, 0.001), 0.0, 1.0);
        float trailSoft = 1.0 - smoothstep(0.0, 1.0, trailNorm);

        // Soft head + tighter core to keep the leading edge readable.
        float headSoft = 1.0 - smoothstep(0.0, 0.18, offset);
        float headCore = 1.0 - smoothstep(0.0, 0.06, offset);

        float totalGlow = clamp(trailSoft * 0.58 + headSoft * 0.30 + headCore * 0.22, 0.0, 1.0);
        totalGlow = smoothstep(0.0, 1.0, totalGlow);

        outRgb = mix(outRgb, vec3(1.0), 0.40 * totalGlow);
        outRgb += vec3(0.13) * totalGlow;
        outAlpha = min(0.95, outAlpha + (0.14 * totalGlow));
    }

    gl_FragColor = vec4(outRgb, outAlpha);
}
