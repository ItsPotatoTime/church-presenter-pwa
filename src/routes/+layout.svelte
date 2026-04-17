<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<main>
  {@render children()}
</main>

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 20px 16px 40px;
  }
</style>
