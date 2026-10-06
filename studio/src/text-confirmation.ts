/** Electron does not implement window.prompt; this also works in a browser. */
export function textConfirmation(message: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement('dialog');
    modal.className = 'text-confirmation';
    const form = document.createElement('form');
    form.method = 'dialog';
    const heading = document.createElement('h2'); heading.textContent = '确认操作';
    const label = document.createElement('label'); label.textContent = message;
    const input = document.createElement('input'); input.autocomplete = 'off'; input.setAttribute('aria-label', '操作确认文本');
    label.append(input);
    const actions = document.createElement('div');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.className = 'secondary';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '确认'; submit.className = 'primary';
    actions.append(cancel, submit); form.append(heading, label, actions); modal.append(form);
    let value: string | null = null;
    form.addEventListener('submit', () => {value = input.value;});
    cancel.addEventListener('click', () => modal.close());
    modal.addEventListener('close', () => {modal.remove(); resolve(value);}, {once: true});
    document.body.append(modal); modal.showModal(); input.focus();
  });
}
